// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {afterEach, describe, expect, it} from '@jest/globals';

import {authorizeAnalysisContext} from '../analysisContextAuthorization';
import {
  AnalysisContextAuthorizationChangedError,
  analysisContextMemoryPartitionKey,
  assertCurrentAnalysisContextAuthorization,
  buildAnalysisContextAuthorizationFingerprint,
} from '../resolvedAnalysisContext';
import {effectiveAnalysisSelection} from '../effectiveAnalysisSelection';
import {CodebaseRegistry} from '../codebase/codebaseRegistry';
import {PathSecurityGate} from '../codebase/pathSecurityGate';
import {contentDisclosure} from '../codebase/sourceDisclosure';
import {ExternalKnowledgeSourceRegistry} from '../externalKnowledgeSourceRegistry';

const scope = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'};
const roots: string[] = [];
let codebaseRegistry: CodebaseRegistry;
let knowledgeRegistry: ExternalKnowledgeSourceRegistry;
/** The allowlist the registered test roots live under. */
const gate = new PathSecurityGate({allowlistRoots: [tmpdir()]});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});

function registerCodebase(sendToProvider = true, pathFilters?: string[]): string {
  const testRoot = mkdtempSync(join(tmpdir(), 'smartperfetto-auth-'));
  roots.push(testRoot);
  codebaseRegistry = new CodebaseRegistry(join(testRoot, 'codebases.json'));
  knowledgeRegistry = new ExternalKnowledgeSourceRegistry(join(testRoot, 'knowledge.json'));
  return codebaseRegistry.register({
    displayName: 'App',
    kind: 'app_source',
    rootPath: testRoot,
    pathFilters,
    sendToProvider,
    consentedBy: scope.userId,
    ...scope,
  }).codebaseId;
}

/** Adds another codebase to the current registries, under its own root. */
function addCodebase(sendToProvider = true, pathFilters?: string[]): {codebaseId: string; root: string} {
  const root = mkdtempSync(join(tmpdir(), 'smartperfetto-auth-extra-'));
  roots.push(root);
  const codebaseId = codebaseRegistry.register({
    displayName: 'Extra', kind: 'app_source', rootPath: root, pathFilters, sendToProvider, consentedBy: scope.userId, ...scope,
  }).codebaseId;
  return {codebaseId, root};
}

function authorize(selection: Parameters<typeof authorizeAnalysisContext>[0]['selection'], extra: Partial<Parameters<typeof authorizeAnalysisContext>[0]> = {}) {
  return authorizeAnalysisContext({
    selection, scope, outputLanguage: 'en', canReadRegisteredContext: true, featureEnabled: true,
    codebaseRegistry, knowledgeRegistry, gate, ...extra,
  });
}

describe('authorizeAnalysisContext', () => {
  it('allows an empty analysis context without codebase permission', () => {
    expect(authorizeAnalysisContext({
      selection: {},
      scope,
      outputLanguage: 'en',
      canReadRegisteredContext: false,
      featureEnabled: true,
    })).toEqual({allowed: true});
  });

  it('denies registered context without codebase:read', () => {
    expect(authorizeAnalysisContext({
      selection: {codeAwareMode: 'metadata_only', codebaseIds: ['app']},
      scope,
      outputLanguage: 'en',
      canReadRegisteredContext: false,
      featureEnabled: true,
    })).toMatchObject({allowed: false, httpStatus: 403});
  });

  it('requires provider consent only for provider_send mode', () => {
    const codebaseId = registerCodebase(false);
    const metadataDecision = authorizeAnalysisContext({
      selection: {codeAwareMode: 'metadata_only', codebaseIds: [codebaseId]},
      scope,
      outputLanguage: 'en',
      canReadRegisteredContext: true,
      featureEnabled: true,
      codebaseRegistry,
      knowledgeRegistry,
      gate,
    });
    const providerDecision = authorizeAnalysisContext({
      selection: {codeAwareMode: 'provider_send', codebaseIds: [codebaseId]},
      scope,
      outputLanguage: 'en',
      canReadRegisteredContext: true,
      featureEnabled: true,
      codebaseRegistry,
      knowledgeRegistry,
      gate,
    });

    expect(metadataDecision).toEqual({allowed: true});
    expect(providerDecision).toMatchObject({
      allowed: false,
      httpStatus: 409,
      payload: {code: 'ANALYSIS_CONTEXT_CODEBASE_NOT_CONSENTED',
        codebases: [{codebaseId, reason: 'consent_required'}]},
    });
  });

  it('names each failing codebase with one fixed reason, root before mode, and never a path', () => {
    const consented = registerCodebase();
    const missing = addCodebase();
    const unconsented = addCodebase(false);
    rmSync(missing.root, {recursive: true, force: true});

    const decision = authorize({codeAwareMode: 'provider_send', codebaseIds: [consented, missing.codebaseId, unconsented.codebaseId]});
    expect(decision).toEqual({allowed: false, httpStatus: 409, payload: expect.objectContaining({
      code: 'ANALYSIS_CONTEXT_CODEBASE_ROOT_UNAVAILABLE',
      codebases: [
        {codebaseId: missing.codebaseId, reason: 'root_missing'},
        {codebaseId: unconsented.codebaseId, reason: 'consent_required'},
      ],
    })});
    expect(JSON.stringify(decision)).not.toContain(tmpdir());

    expect(authorize({codeAwareMode: 'metadata_only', codebaseIds: [consented]},
      {gate: new PathSecurityGate({allowlistRoots: []})})).toMatchObject({
      payload: {code: 'ANALYSIS_CONTEXT_CODEBASE_ROOT_UNAVAILABLE', codebases: [{codebaseId: consented, reason: 'outside_allowlist'}]},
    });
  });

  it('refuses provider_send while a grant no longer matches the selection', () => {
    const codebaseId = registerCodebase(true, ['app']);
    const registryPath = join(roots[roots.length - 1], 'codebases.json');
    const envelope = JSON.parse(readFileSync(registryPath, 'utf8'));
    envelope.codebases[0].consent.grant.includePrefixes = ['app/src'];
    writeFileSync(registryPath, JSON.stringify(envelope));
    codebaseRegistry = new CodebaseRegistry(registryPath);

    expect(authorize({codeAwareMode: 'provider_send', codebaseIds: [codebaseId]})).toMatchObject({
      allowed: false,
      httpStatus: 409,
      payload: {code: 'ANALYSIS_CONTEXT_CODEBASE_CONSENT_STALE', codebases: [{codebaseId, reason: 'consent_scope_stale'}]},
    });
    expect(authorize({codeAwareMode: 'metadata_only', codebaseIds: [codebaseId]})).toEqual({allowed: true});
  });

  it('reads an explicit off as no codebases: hidden ids need no permission, feature or registration', () => {
    registerCodebase();
    const hidden = {codeAwareMode: 'off' as const, codebaseIds: ['cb_does_not_exist']};
    expect(authorize(hidden, {canReadRegisteredContext: false, featureEnabled: false})).toEqual({allowed: true});
    // Knowledge sources stay selected under off.
    expect(authorize({...hidden, knowledgeSourceIds: ['ks_missing']}, {canReadRegisteredContext: false}))
      .toMatchObject({allowed: false, httpStatus: 403});
    // Ids without a mode are metadata_only and are checked.
    expect(authorize({codebaseIds: ['cb_does_not_exist']})).toMatchObject({allowed: false, httpStatus: 404});
  });

  it('denies inactive external knowledge', () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'smartperfetto-knowledge-auth-'));
    roots.push(testRoot);
    codebaseRegistry = new CodebaseRegistry(join(testRoot, 'codebases.json'));
    knowledgeRegistry = new ExternalKnowledgeSourceRegistry(join(testRoot, 'knowledge.json'));
    const source = knowledgeRegistry.register({
      kind: 'document_collection',
      displayName: 'Docs',
      rootRealpath: testRoot,
      revision: 'rev-1',
      contentFingerprint: 'fingerprint',
      license: 'internal',
      rightsAcknowledged: true,
      sendToProvider: true,
      consentedBy: scope.userId,
      scope,
      dirty: false,
    });

    expect(authorizeAnalysisContext({
      selection: {knowledgeSourceIds: [source.sourceId]},
      scope,
      outputLanguage: 'en',
      canReadRegisteredContext: true,
      featureEnabled: true,
      codebaseRegistry,
      knowledgeRegistry,
    })).toMatchObject({
      allowed: false,
      payload: {code: 'ANALYSIS_CONTEXT_SOURCE_UNAVAILABLE'},
    });
  });

  it('refuses a retired Wiki source even when its rights, consent and index are all in place', async () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'smartperfetto-knowledge-retired-'));
    roots.push(testRoot);
    codebaseRegistry = new CodebaseRegistry(join(testRoot, 'codebases.json'));
    const knowledgePath = join(testRoot, 'knowledge.json');
    knowledgeRegistry = new ExternalKnowledgeSourceRegistry(knowledgePath);
    const collection = knowledgeRegistry.register({
      kind: 'document_collection', displayName: 'Docs', rootRealpath: testRoot, revision: 'rev-1',
      contentFingerprint: 'fingerprint', rightsAcknowledged: true, sendToProvider: true,
      consentedBy: scope.userId, scope, dirty: false,
    });
    await knowledgeRegistry.withIngestLease(collection.sourceId, scope, lease => lease.activateGeneration({
      generation: 'dc_' + '1'.repeat(32), revision: 'rev-1', contentFingerprint: 'fingerprint', dirty: false,
      indexedArticleCount: 1, indexedChunkCount: 1,
    }));
    expect(authorize({knowledgeSourceIds: [collection.sourceId]})).toEqual({allowed: true});
    // The same usable record as the retired connector stored it; registration
    // no longer writes this kind, so only stored state carries it.
    const envelope = JSON.parse(readFileSync(knowledgePath, 'utf8'));
    const retired = {...envelope.sources[0], kind: 'android_internals_wiki', sourceId: `eks_${'f'.repeat(24)}`};
    envelope.sources.push(retired);
    writeFileSync(knowledgePath, JSON.stringify(envelope));

    for (const [outputLanguage, text] of [['en', 'retired legacy Wiki connector'], ['zh-CN', '已停用的旧版 Wiki 连接器']] as const) {
      const decision = authorize({knowledgeSourceIds: [collection.sourceId, retired.sourceId]}, {outputLanguage});
      expect(decision).toMatchObject({allowed: false, httpStatus: 409, payload: {code: 'ANALYSIS_CONTEXT_SOURCE_RETIRED'}});
      expect(JSON.stringify(decision)).toContain(text);
    }
    // An unknown id is still answered first.
    expect(authorize({knowledgeSourceIds: [retired.sourceId, 'ks_missing']})).toMatchObject({httpStatus: 404});
  });
});

describe('analysis context authorization fingerprint', () => {
  // A resumed session is continued only when the request's fingerprint equals
  // the one it ran under, so the value must survive a reload of the registry.
  it('is stable across a registry reload and changes with consent, selection policy and scope', () => {
    const codebaseId = registerCodebase();
    const registryPath = join(roots[roots.length - 1], 'codebases.json');
    const selection = {codeAwareMode: 'provider_send' as const, codebaseIds: [codebaseId]};
    const fingerprint = (registry: CodebaseRegistry, owner = scope) =>
      buildAnalysisContextAuthorizationFingerprint(selection, owner, {codebaseRegistry: registry, knowledgeRegistry});

    const original = fingerprint(codebaseRegistry);
    expect(fingerprint(new CodebaseRegistry(registryPath))).toBe(original);
    expect(fingerprint(new CodebaseRegistry(registryPath), {...scope, userId: 'user-b'})).not.toBe(original);

    new CodebaseRegistry(registryPath).updateSelectionPolicy(codebaseId, scope, {pathFilters: ['app/']});
    const afterPolicy = fingerprint(new CodebaseRegistry(registryPath));
    expect(afterPolicy).not.toBe(original);

    new CodebaseRegistry(registryPath).setProviderConsent(codebaseId, scope, false, scope.userId);
    expect(fingerprint(new CodebaseRegistry(registryPath))).not.toBe(afterPolicy);
  });
});

describe('analysis context fingerprint format acf2', () => {
  function registerIndexedSources() {
    const codebaseId = registerCodebase();
    const knowledgeRoot = roots[roots.length - 1];
    const source = knowledgeRegistry.register({
      kind: 'document_collection', displayName: 'Docs', rootRealpath: knowledgeRoot, revision: 'content-1',
      contentFingerprint: 'fingerprint-1', dirty: false, rightsAcknowledged: true, sendToProvider: true,
      consentedBy: scope.userId, scope,
    });
    return {codebaseId, sourceId: source.sourceId};
  }

  it('carries a format prefix, so a fingerprint stamped before it never matches', async () => {
    const {codebaseId, sourceId} = registerIndexedSources();
    const selection = {codeAwareMode: 'provider_send' as const, codebaseIds: [codebaseId], knowledgeSourceIds: [sourceId]};
    const current = buildAnalysisContextAuthorizationFingerprint(selection, scope, {codebaseRegistry, knowledgeRegistry});
    expect(current).toMatch(/^acf2:[0-9a-f]{64}$/);
    // The same authorization under the previous format: a bare digest.
    for (const stored of ['0'.repeat(64), current.slice('acf2:'.length)]) {
      expect(() => assertCurrentAnalysisContextAuthorization(selection, scope, stored, {codebaseRegistry, knowledgeRegistry}))
        .toThrow(AnalysisContextAuthorizationChangedError);
    }
    expect(() => assertCurrentAnalysisContextAuthorization(selection, scope, current, {codebaseRegistry, knowledgeRegistry}))
      .not.toThrow();
  });

  it('ignores index rebuilds but follows consent, selection and deletion', async () => {
    const {codebaseId, sourceId} = registerIndexedSources();
    const selection = {codeAwareMode: 'provider_send' as const, codebaseIds: [codebaseId], knowledgeSourceIds: [sourceId]};
    const fingerprint = () => buildAnalysisContextAuthorizationFingerprint(selection, scope, {codebaseRegistry, knowledgeRegistry});
    const original = fingerprint();

    // Codebase rebuilds: a new active generation, twice.
    for (const generation of ['generation-1', 'generation-2']) {
      const ref = codebaseRegistry.get(codebaseId, scope)!;
      codebaseRegistry.activateIndexGeneration(codebaseId, scope, ref.indexGeneration, {lastIngestStatus: 'ok',
        activeGeneration: generation, contentFingerprint: generation.padEnd(64, '0'), chunkCount: 3});
      expect(fingerprint()).toBe(original);
    }
    // Knowledge rebuilds: a new active generation and content.
    for (const generation of ['dc_' + '1'.repeat(32), 'dc_' + '2'.repeat(32)]) {
      await knowledgeRegistry.withIngestLease(sourceId, scope, lease => lease.activateGeneration({generation,
        revision: `content-${generation}`, contentFingerprint: generation, dirty: false,
        indexedArticleCount: 2, indexedChunkCount: 5}));
      expect(fingerprint()).toBe(original);
    }

    knowledgeRegistry.setProviderConsent(sourceId, scope, false, scope.userId);
    const withoutKnowledgeConsent = fingerprint();
    expect(withoutKnowledgeConsent).not.toBe(original);
    codebaseRegistry.updateSelectionPolicy(codebaseId, scope, {pathFilters: ['app/']});
    const afterSelection = fingerprint();
    expect(afterSelection).not.toBe(withoutKnowledgeConsent);
    await knowledgeRegistry.remove(sourceId, scope, scope.userId, () => undefined);
    expect(fingerprint()).not.toBe(afterSelection);
  });
});

describe('the effective analysis selection', () => {
  it.each([
    ['explicit off drops codebase ids', {codeAwareMode: 'off', codebaseIds: ['a'], knowledgeSourceIds: ['k']},
      {codeAwareMode: 'off', knowledgeSourceIds: ['k']}],
    ['ids without a mode mean metadata_only', {codebaseIds: ['a', 'a', 'b']},
      {codeAwareMode: 'metadata_only', codebaseIds: ['a', 'b']}],
    ['a mode without ids means off', {codeAwareMode: 'provider_send', codebaseIds: []}, {codeAwareMode: 'off'}],
    ['nothing selected is off', {}, {codeAwareMode: 'off'}],
    ['provider_send keeps its ids', {codeAwareMode: 'provider_send', codebaseIds: ['b']},
      {codeAwareMode: 'provider_send', codebaseIds: ['b']}],
  ] as const)('%s', (_label, selection, expected) => {
    expect(effectiveAnalysisSelection(selection)).toEqual(expected);
  });

  it('gives one fingerprint and one memory partition to selections that mean the same', () => {
    const codebaseId = registerCodebase();
    const registries = {codebaseRegistry, knowledgeRegistry};
    const fingerprint = (selection: Parameters<typeof buildAnalysisContextAuthorizationFingerprint>[0]) =>
      buildAnalysisContextAuthorizationFingerprint(selection, scope, registries);

    expect(fingerprint({codeAwareMode: 'off', codebaseIds: [codebaseId]})).toBe(fingerprint({}));
    expect(fingerprint({codeAwareMode: 'provider_send'})).toBe(fingerprint({}));
    expect(fingerprint({codebaseIds: [codebaseId]})).toBe(fingerprint({codeAwareMode: 'metadata_only', codebaseIds: [codebaseId]}));
    expect(fingerprint({codebaseIds: [codebaseId]})).not.toBe(fingerprint({}));
    expect(analysisContextMemoryPartitionKey({codeAwareMode: 'off', codebaseIds: [codebaseId]})).toBe('trace-public');
    expect(analysisContextMemoryPartitionKey({codebaseIds: [codebaseId]}))
      .toBe(analysisContextMemoryPartitionKey({codeAwareMode: 'metadata_only', codebaseIds: [codebaseId]}));
  });

  it('keeps the fingerprint across changes that grant nothing new', async () => {
    const codebaseId = registerCodebase(true, ['app']);
    const unselected = addCodebase();
    const selection = {codeAwareMode: 'provider_send' as const, codebaseIds: [codebaseId]};
    const fingerprint = () => buildAnalysisContextAuthorizationFingerprint(selection, scope, {codebaseRegistry, knowledgeRegistry});
    const original = fingerprint();

    // Registration already granted the current selection and every language.
    codebaseRegistry.setProviderConsent(codebaseId, scope, true, scope.userId);
    const token = contentDisclosure(codebaseRegistry.get(codebaseId, scope)!).token;
    codebaseRegistry.authorizeContent(codebaseId, scope, scope.userId, token);
    codebaseRegistry.authorizeContent(codebaseId, scope, scope.userId, token);
    codebaseRegistry.authorizeAvailableExtensions(codebaseId, scope, scope.userId);
    codebaseRegistry.authorizeCurrentSelection(codebaseId, scope, scope.userId);
    codebaseRegistry.updateSelectionPolicy(codebaseId, scope, {pathFilters: ['app/', './app']});
    codebaseRegistry.setProviderConsent(unselected.codebaseId, scope, false, scope.userId);
    codebaseRegistry.updateSelectionPolicy(unselected.codebaseId, scope, {pathFilters: ['lib']});
    await codebaseRegistry.withIngestLease(unselected.codebaseId, scope, lease => {
      lease.beginDeletion(scope.userId);
      lease.deleteRegistration();
    }, 'delete');
    expect(codebaseRegistry.get(unselected.codebaseId, scope)).toBeUndefined();
    expect(fingerprint()).toBe(original);
    // A real change of what is granted is a new authorization.
    codebaseRegistry.updateSelectionPolicy(codebaseId, scope, {pathFilters: ['app/src']});
    expect(fingerprint()).not.toBe(original);
  });
});
