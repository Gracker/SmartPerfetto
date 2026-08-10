// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {describe, expect, it} from '@jest/globals';

import type {SessionStateSnapshot} from '../../agentv3/sessionStateSnapshot';
import {projectPrivateSessionStateSnapshot} from '../security/privateAnalysisProjection';

function snapshot(): SessionStateSnapshot {
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
    codeLookupSummary: {
      lookupCount: 3,
      patchCount: 0,
      referencedCodebaseIds: ['codebase-a', 'bad path'],
      usedCodebaseIds: ['codebase-a', '/Users/chris/Code/App'],
      usedKnowledgeSources: [{
        knowledgeSourceId: 'knowledge-a',
        sourceGenerations: ['generation-7'],
      }],
    },
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

    expect(projected.codeLookupSummary).toEqual({
      lookupCount: 3,
      patchCount: 0,
      referencedCodebaseIds: ['codebase-a'],
      usedCodebaseIds: ['codebase-a'],
      usedKnowledgeSources: [{
        knowledgeSourceId: 'knowledge-a',
        sourceGenerations: ['generation-7'],
      }],
    });
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
    expect(projected.conversationSteps).toEqual([]);
  });
});
