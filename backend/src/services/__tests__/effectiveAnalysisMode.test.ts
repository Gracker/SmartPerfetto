// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {
  analysisContextRequiresFullMode,
  buildSmartDeepDiveAnalysisContext,
  resolveEffectiveAnalysisMode,
} from '../effectiveAnalysisMode';
import {
  AnalysisContextAuthorizationChangedError,
  analysisContextMemoryPartitionKey,
  analysisContextUsesPrivateKnowledge,
  assertCurrentAnalysisContextAuthorization,
  buildAnalysisContextAuthorizationFingerprint,
} from '../resolvedAnalysisContext';

describe('effective analysis mode', () => {
  it('keeps dedicated conversation lightweight with authorized source context', () => {
    expect(resolveEffectiveAnalysisMode('fast', {
      assistantSurface: 'conversation',
      codeAwareMode: 'provider_send',
      codebaseIds: ['app'],
      knowledgeSourceIds: ['wiki'],
    })).toBe('fast');
  });

  it.each([
    ['trace only', {}, false, 'fast'],
    ['codebase ids with implicit metadata mode', {codebaseIds: ['app']}, true, 'full'],
    ['provider source', {codeAwareMode: 'provider_send', codebaseIds: ['app']}, true, 'full'],
    ['private RAG only', {knowledgeSourceIds: ['wiki']}, true, 'full'],
    ['source and private RAG', {
      codeAwareMode: 'provider_send',
      codebaseIds: ['app'],
      knowledgeSourceIds: ['wiki'],
    }, true, 'full'],
    ['dual trace', {referenceTraceId: 'reference'}, true, 'full'],
  ] as const)('%s resolves explicit fast without silently dropping capabilities', (
    _label,
    context,
    requiresFull,
    expectedMode,
  ) => {
    expect(analysisContextRequiresFullMode(context)).toBe(requiresFull);
    expect(resolveEffectiveAnalysisMode('fast', context)).toBe(expectedMode);
  });

  it.each([
    ['trace only', {}, false],
    ['codebase only', {codebaseIds: ['app']}, true],
    ['private RAG only', {knowledgeSourceIds: ['wiki']}, true],
    ['source and private RAG', {codebaseIds: ['app'], knowledgeSourceIds: ['wiki']}, true],
  ] as const)('%s identifies the cross-session privacy boundary', (_label, context, expected) => {
    expect(analysisContextUsesPrivateKnowledge(context)).toBe(expected);
  });

  it.each([
    ['trace only', 'fast', {}, {analysisMode: 'fast'}],
    ['source only', 'fast', {
      codeAwareMode: 'metadata_only',
      codebaseIds: ['app'],
    }, {
      analysisMode: 'full',
      codeAwareMode: 'metadata_only',
      codebaseIds: ['app'],
    }],
    ['private RAG only', 'fast', {
      knowledgeSourceIds: ['wiki'],
    }, {
      analysisMode: 'full',
      knowledgeSourceIds: ['wiki'],
    }],
    ['source and private RAG', 'fast', {
      codeAwareMode: 'provider_send',
      codebaseIds: ['app'],
      knowledgeSourceIds: ['wiki'],
    }, {
      analysisMode: 'full',
      codeAwareMode: 'provider_send',
      codebaseIds: ['app'],
      knowledgeSourceIds: ['wiki'],
    }],
    ['default Smart deep dive', 'auto', {}, {analysisMode: 'full'}],
  ] as const)('%s preserves the Smart deep-dive context contract', (
    _label,
    requested,
    context,
    expected,
  ) => {
    expect(buildSmartDeepDiveAnalysisContext(requested, context)).toEqual(expected);
  });

  it('partitions in-memory SQL correction state by the exact private selection', () => {
    expect(analysisContextMemoryPartitionKey({})).toBe('trace-public');
    expect(analysisContextMemoryPartitionKey({codebaseIds: ['app-a']}))
      .not.toBe(analysisContextMemoryPartitionKey({codebaseIds: ['app-b']}));
    expect(analysisContextMemoryPartitionKey({knowledgeSourceIds: ['wiki'], codebaseIds: ['app']}))
      .toBe(analysisContextMemoryPartitionKey({codebaseIds: ['app'], knowledgeSourceIds: ['wiki']}));
  });

  it('fails the final run boundary when consent changes after retrieval', () => {
    let sendToProvider = true;
    const codebaseRegistry = {
      get: () => ({
        codebaseId: 'app',
        indexGeneration: 2,
        consent: {consentHash: sendToProvider ? 'allowed' : 'revoked', sendToProvider},
      }),
    } as any;
    const selection = {codeAwareMode: 'provider_send' as const, codebaseIds: ['app']};
    const scope = {tenantId: 'tenant', workspaceId: 'workspace', userId: 'user'};
    const expected = buildAnalysisContextAuthorizationFingerprint(selection, scope, {codebaseRegistry});

    sendToProvider = false;

    expect(() => assertCurrentAnalysisContextAuthorization(
      selection,
      scope,
      expected,
      {codebaseRegistry},
    )).toThrow(AnalysisContextAuthorizationChangedError);
  });

  it('includes source license state in the authorization fingerprint', () => {
    let licenseTag = 'Apache-2.0';
    const codebaseRegistry = {
      get: () => ({
        codebaseId: 'aosp',
        indexGeneration: 2,
        activeGeneration: 'codebase_2_active',
        contentFingerprint: 'fingerprint',
        licenseTag,
        consent: {consentHash: 'allowed', sendToProvider: true},
      }),
    } as any;
    const selection = {codeAwareMode: 'provider_send' as const, codebaseIds: ['aosp']};
    const scope = {tenantId: 'tenant', workspaceId: 'workspace', userId: 'user'};
    const expected = buildAnalysisContextAuthorizationFingerprint(selection, scope, {codebaseRegistry});

    licenseTag = 'UNKNOWN';

    expect(() => assertCurrentAnalysisContextAuthorization(
      selection,
      scope,
      expected,
      {codebaseRegistry},
    )).toThrow(AnalysisContextAuthorizationChangedError);
  });

  it('includes the source selection-policy revision in the authorization fingerprint', () => {
    let selectionPolicyRevision = 1;
    const codebaseRegistry = {
      get: () => ({
        codebaseId: 'app',
        indexGeneration: 1,
        activeIndexState: 'none',
        selectionPolicyRevision,
        consent: {
          consentHash: 'metadata-consent',
          sendToProvider: false,
          grant: {revision: 1},
        },
      }),
    } as any;
    const selection = {codeAwareMode: 'metadata_only' as const, codebaseIds: ['app']};
    const scope = {tenantId: 'tenant', workspaceId: 'workspace', userId: 'user'};
    const expected = buildAnalysisContextAuthorizationFingerprint(selection, scope, {codebaseRegistry});

    selectionPolicyRevision = 2;

    expect(() => assertCurrentAnalysisContextAuthorization(
      selection,
      scope,
      expected,
      {codebaseRegistry},
    )).toThrow(AnalysisContextAuthorizationChangedError);
  });

  it('fails the final run boundary when a knowledge generation loses its active chunks', () => {
    let indexedChunkCount = 3;
    const knowledgeRegistry = {
      get: () => ({
        sourceId: 'wiki',
        indexGeneration: 2,
        activeGeneration: 'knowledge_2_test',
        contentFingerprint: 'c'.repeat(64),
        indexedChunkCount,
        rightsAcknowledged: true,
        sendToProvider: true,
        consentedAt: 1,
      }),
    } as any;
    const selection = {knowledgeSourceIds: ['wiki']};
    const scope = {tenantId: 'tenant', workspaceId: 'workspace', userId: 'user'};
    const expected = buildAnalysisContextAuthorizationFingerprint(
      selection,
      scope,
      {knowledgeRegistry},
    );

    indexedChunkCount = 0;

    expect(() => assertCurrentAnalysisContextAuthorization(
      selection,
      scope,
      expected,
      {knowledgeRegistry},
    )).toThrow(AnalysisContextAuthorizationChangedError);
  });
});
