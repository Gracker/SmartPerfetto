// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {mkdtempSync, rmSync} from 'fs';
import {tmpdir} from 'os';
import {join} from 'path';

import {afterEach, describe, expect, it} from '@jest/globals';

import {authorizeAnalysisContext} from '../analysisContextAuthorization';
import {CodebaseRegistry} from '../codebase/codebaseRegistry';
import {ExternalKnowledgeSourceRegistry} from '../externalKnowledgeSourceRegistry';

const scope = {tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a'};
const roots: string[] = [];
let codebaseRegistry: CodebaseRegistry;
let knowledgeRegistry: ExternalKnowledgeSourceRegistry;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, {recursive: true, force: true});
});

function registerCodebase(sendToProvider = true): string {
  const testRoot = mkdtempSync(join(tmpdir(), 'smartperfetto-auth-'));
  roots.push(testRoot);
  codebaseRegistry = new CodebaseRegistry(join(testRoot, 'codebases.json'));
  knowledgeRegistry = new ExternalKnowledgeSourceRegistry(join(testRoot, 'knowledge.json'));
  return codebaseRegistry.register({
    displayName: 'App',
    kind: 'app_source',
    rootPath: testRoot,
    sendToProvider,
    consentedBy: scope.userId,
    ...scope,
  }).codebaseId;
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
    });
    const providerDecision = authorizeAnalysisContext({
      selection: {codeAwareMode: 'provider_send', codebaseIds: [codebaseId]},
      scope,
      outputLanguage: 'en',
      canReadRegisteredContext: true,
      featureEnabled: true,
      codebaseRegistry,
      knowledgeRegistry,
    });

    expect(metadataDecision).toEqual({allowed: true});
    expect(providerDecision).toMatchObject({
      allowed: false,
      httpStatus: 409,
      payload: {code: 'ANALYSIS_CONTEXT_CODEBASE_NOT_CONSENTED'},
    });
  });

  it('denies inactive external knowledge', () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'smartperfetto-knowledge-auth-'));
    roots.push(testRoot);
    codebaseRegistry = new CodebaseRegistry(join(testRoot, 'codebases.json'));
    knowledgeRegistry = new ExternalKnowledgeSourceRegistry(join(testRoot, 'knowledge.json'));
    const source = knowledgeRegistry.register({
      kind: 'android_internals_wiki',
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
});
