// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {describe, expect, it} from '@jest/globals';

import {
  normalizeSessionStateSnapshot,
  type SessionStateSnapshot,
} from '../../agentv3/sessionStateSnapshot';
import {
  SOURCE_USE_DECISION_SCHEMA_VERSION,
  sanitizeSourceReference,
} from '../codebase/sourceUseDecision';
import {projectPrivateSessionStateSnapshot} from '../security/privateAnalysisProjection';

function snapshot(): SessionStateSnapshot {
  const sourceReference = {
    referenceId: 'source-safe',
    codebaseId: 'codebase-a',
    filePath: 'src/MainActivity.kt',
    lineRange: {start: 10, end: 12},
    lookupKind: 'body',
    query: 'PRIVATE_REFERENCE_QUERY_CANARY',
    snippet: 'PRIVATE_REFERENCE_SNIPPET_CANARY',
    rootPath: '/PRIVATE_REFERENCE_ROOT_CANARY',
  } as any;
  const sourceUseDecision = {
    schemaVersion: SOURCE_USE_DECISION_SCHEMA_VERSION,
    codeAwareMode: 'provider_send',
    selectedCodebaseIds: ['codebase-a', '/Users/chris/Code/App'],
    status: 'search_incomplete',
    reasonCode: 'search_incomplete',
    attemptedTools: ['search_codebase'],
    queriedCodebaseIds: ['codebase-a'],
    usedCodebaseIds: ['codebase-a'],
    coverageComplete: false,
    incompleteReasons: ['backend_degraded'],
    references: [sourceReference, {
      referenceId: 'unsafe-absolute',
      codebaseId: 'codebase-a',
      filePath: '/PRIVATE_ABSOLUTE_ROOT_CANARY/Secret.kt',
      lookupKind: 'body',
    }],
    rawQuery: 'PRIVATE_DECISION_QUERY_CANARY',
  } as any;
  return {
    version: 1,
    snapshotTimestamp: 1,
    sessionId: 'session-private',
    traceId: 'trace-private',
    conversationSteps: [{
      eventId: 'event-1',
      ordinal: 1,
      phase: 'tool',
      role: 'agent',
      text: 'PRIVATE_SNIPPET_AND_TOOL_ARGUMENTS',
      timestamp: 1,
    }],
    queryHistory: [],
    conclusionHistory: [],
    agentDialogue: [],
    agentResponses: [],
    dataEnvelopes: [],
    hypotheses: [],
    analysisNotes: [],
    analysisPlan: null,
    planHistory: [],
    uncertaintyFlags: [],
    codebaseIds: ['codebase-a', '/Users/chris/Code/App'],
    knowledgeSourceIds: ['knowledge-a', '../knowledge-root'],
    traceSummary: {
      schemaVersion: 'trace_summary_attribution@1', status: 'ready',
      specId: 'smartperfetto.core.v1', specDigestSha256: 'a'.repeat(64),
      traceFingerprintSha256: 'b'.repeat(64),
      traceProcessor: {source: 'custom', binarySha256: 'c'.repeat(64), localPath: '/private/tp'},
      resultDigestSha256: 'd'.repeat(64),
      availableMetricIds: ['metric_a'], missingMetricIds: [],
      localPath: '/private/trace',
    } as any,
    codeLookupSummary: {
      lookupCount: 3,
      patchCount: 0,
      referencedCodebaseIds: ['codebase-a', 'bad path'],
      usedCodebaseIds: ['codebase-a', '/Users/chris/Code/App'],
      usedKnowledgeSources: [{
        knowledgeSourceId: 'knowledge-a',
        sourceGenerations: ['generation-7'],
      }],
      sourceUseDecision,
    },
    sourceUseDecision,
    codebaseSnapshot: [{
      codebaseId: 'codebase-a',
      displayName: 'App Source',
      kind: 'app_source',
      indexGeneration: 7,
      activeGeneration: 'codebase_7',
      rootPath: '/Users/chris/Code/App',
      rootRealpath: '/private/var/App',
    } as any, {
      codebaseId: 'bad path',
      displayName: '/Users/chris/Code/Secret',
      kind: 'not-a-kind',
      indexGeneration: 8,
    } as any],
    runSequence: 1,
    conversationOrdinal: 1,
  };
}

describe('private session snapshot provenance', () => {
  it('keeps bounded source generation provenance without private content', () => {
    const projected = projectPrivateSessionStateSnapshot(snapshot());
    const safeReference = sanitizeSourceReference({
      referenceId: 'source-safe',
      codebaseId: 'codebase-a',
      filePath: 'src/MainActivity.kt',
      lineRange: {start: 10, end: 12},
      lookupKind: 'body',
    });

    expect(projected.codeLookupSummary).toEqual({
      lookupCount: 3,
      patchCount: 0,
      referencedCodebaseIds: ['codebase-a'],
      usedCodebaseIds: ['codebase-a'],
      usedKnowledgeSources: [{
        knowledgeSourceId: 'knowledge-a',
        sourceGenerations: ['generation-7'],
      }],
      sourceUseDecision: {
        schemaVersion: SOURCE_USE_DECISION_SCHEMA_VERSION,
        codeAwareMode: 'provider_send',
        selectedCodebaseIds: ['codebase-a'],
        status: 'search_incomplete',
        reasonCode: 'search_incomplete',
        attemptedTools: ['search_codebase'],
        queriedCodebaseIds: ['codebase-a'],
        usedCodebaseIds: ['codebase-a'],
        coverageComplete: false,
        incompleteReasons: ['backend_degraded'],
        references: [safeReference],
      },
    });
    expect(projected.sourceUseDecision).toEqual(projected.codeLookupSummary?.sourceUseDecision);
    expect(projected.codebaseSnapshot).toEqual([{
      codebaseId: 'codebase-a',
      displayName: 'App Source',
      kind: 'app_source',
      indexGeneration: 7,
      activeGeneration: 'codebase_7',
    }]);
    expect(projected.codebaseIds).toEqual(['codebase-a']);
    expect(projected.knowledgeSourceIds).toEqual(['knowledge-a']);
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_SNIPPET_AND_TOOL_ARGUMENTS');
    expect(JSON.stringify(projected)).not.toContain('/Users/chris/Code/App');
    expect(JSON.stringify(projected)).not.toContain('/private/var/App');
    expect(JSON.stringify(projected)).not.toContain('PRIVATE_');
    expect(projected.conversationSteps).toEqual([]);
    expect(projected.traceSummary).toEqual(expect.objectContaining({
      status: 'ready', resultDigestSha256: 'd'.repeat(64),
    }));
    expect(JSON.stringify(projected.traceSummary)).not.toContain('/private/');
  });

  it('migrates a summary-only source decision into the additive snapshot field', () => {
    const legacy = snapshot();
    delete legacy.sourceUseDecision;

    const normalized = normalizeSessionStateSnapshot(legacy);

    expect(normalized.sourceUseDecision).toEqual(
      normalized.codeLookupSummary?.sourceUseDecision,
    );
    expect(normalized.sourceUseDecision).toEqual(expect.objectContaining({
      schemaVersion: SOURCE_USE_DECISION_SCHEMA_VERSION,
      selectedCodebaseIds: ['codebase-a'],
      status: 'search_incomplete',
    }));
    expect(JSON.stringify(normalized.sourceUseDecision)).not.toContain('PRIVATE_');
  });
});
