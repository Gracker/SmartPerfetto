// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {
  buildSmartDeepDiveAnalysisContext,
  resolveEffectiveAnalysisMode,
  type AnalysisModeContext,
} from '../effectiveAnalysisMode';
import {
  AnalysisContextAuthorizationChangedError,
  analysisContextMemoryPartitionKey,
  assertCurrentAnalysisContextAuthorization,
  buildAnalysisContextAuthorizationFingerprint,
} from '../resolvedAnalysisContext';

describe('effective analysis mode', () => {
  const sourceSelections: ReadonlyArray<{label: string; context: AnalysisModeContext}> = [
    {label: 'trace', context: {}},
    {label: 'implicit metadata', context: {codebaseIds: ['app']}},
    {label: 'source off', context: {codeAwareMode: 'off'}},
    {label: 'metadata', context: {codeAwareMode: 'metadata_only', codebaseIds: ['app']}},
    {label: 'source body', context: {codeAwareMode: 'provider_send', codebaseIds: ['app']}},
  ];
  const contexts = sourceSelections.flatMap(source => [false, true].flatMap(reference =>
    [false, true].flatMap(rag => [false, true].map(conversation => ({
      label: `${source.label}; reference=${reference}; RAG=${rag}; conversation=${conversation}`,
      context: {
        ...source.context,
        ...(reference ? {referenceTraceId: 'reference'} : {}),
        ...(rag ? {knowledgeSourceIds: ['wiki']} : {}),
        ...(conversation ? {assistantSurface: 'conversation' as const} : {}),
      } satisfies AnalysisModeContext,
      defaultMode: conversation ? 'fast' : 'auto',
    })))));

  it.each(contexts)('$label preserves each explicit budget and uses the surface default only when absent', ({context, defaultMode}) => {
    expect(resolveEffectiveAnalysisMode('fast', context)).toBe('fast');
    expect(resolveEffectiveAnalysisMode('full', context)).toBe('full');
    expect(resolveEffectiveAnalysisMode('auto', context)).toBe('auto');
    expect(resolveEffectiveAnalysisMode(undefined, context)).toBe(defaultMode);
  });

  it.each(contexts)('$label preserves Smart deep-dive defaults, explicit fast, and exact private allowlists', ({context}) => {
    for (const [requested, expected] of [
      [undefined, 'full'], ['auto', 'full'], ['full', 'full'], ['fast', 'fast'],
    ] as const) {
      const result = buildSmartDeepDiveAnalysisContext(requested, context);
      expect(result.analysisMode).toBe(expected);
      expect(result.codeAwareMode).toBe(context.codeAwareMode);
      expect(result.codebaseIds).toBe(context.codebaseIds);
      expect(result.knowledgeSourceIds).toBe(context.knowledgeSourceIds);
    }
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
