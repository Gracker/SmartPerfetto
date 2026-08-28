// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import {createClaudeMcpServer} from '../../agentv3/claudeMcpServer';
import {
  finalizeSourceAwareAnalysisResult,
  type SourceUseDecisionReader,
} from '../../services/codebase/sourceClaimVerifier';
import type {SourceUseDecisionV1} from '../../services/codebase/sourceUseDecision';
import {sanitizeSourceReference} from '../../services/codebase/sourceUseDecision';
import {projectCodeAwareStreamingUpdate} from '../../services/security/codeAwareStreamingUpdateProjection';
import {
  createRuntimeSourceFinalizationFixture,
  createSourceAuthoredAnalysisResult,
  SOURCE_FINALIZATION_CANARY,
  SOURCE_FINALIZATION_RAW_SOURCE,
} from './sourceFinalizationFixture';

function finalizeSourceResult(
  result: AnalysisResult,
  sourceUse: SourceUseDecisionReader | undefined,
): AnalysisResult {
  return finalizeSourceAwareAnalysisResult(result, sourceUse);
}

function plainResult(sessionId: string): AnalysisResult {
  return {
    sessionId,
    success: true,
    findings: [],
    hypotheses: [],
    conclusion: 'ordinary trace-only conclusion',
    confidence: 0.8,
    rounds: 1,
    totalDurationMs: 10,
  };
}

describe('runtime source finalization behavior', () => {
  test('leaves source-free results byte-for-behavior unchanged', () => {
    const result = plainResult('session-source-free');
    const before = structuredClone(result);

    expect(finalizeSourceResult(result, undefined)).toBe(result);
    expect(result).toEqual(before);
  });

  test('fails closed over fabricated source provenance when no current-run accessor exists', () => {
    const sourceReference = sanitizeSourceReference({
      referenceId: 'fabricated-lookup',
      codebaseId: 'fabricated-app',
      filePath: 'src/Fabricated.kt',
      lookupKind: 'body',
    })!;
    const fabricatedDecision = {
      schemaVersion: 'source_use_decision@1' as const,
      codeAwareMode: 'provider_send' as const,
      selectedCodebaseIds: ['fabricated-app'],
      status: 'corroborated' as const,
      attemptedTools: ['read_codebase_file'],
      queriedCodebaseIds: ['fabricated-app'],
      usedCodebaseIds: ['fabricated-app'],
      references: [{
        ...sourceReference,
        rootPath: '/Users/chris/SECRET_ROOT_CANARY',
        snippet: 'SECRET_SNIPPET_CANARY',
        query: 'SECRET_QUERY_CANARY',
      } as any],
    };
    const result = plainResult('session-fabricated-no-accessor');
    result.sourceUseDecision = fabricatedDecision;
    result.sourceReferences = fabricatedDecision.references;
    result.sourceClaimVerificationResult = {
      schemaVersion: 'source_claim_verifier@1',
      status: 'passed',
      bindings: [],
      issues: [],
    };
    result.conclusionContract = {
      schemaVersion: 'conclusion_contract_v1',
      mode: 'focused_answer',
      conclusions: [],
      clusters: [],
      evidenceChain: [],
      claims: [{id: 'claim-fabricated', text: 'trace fact', references: []}],
      sourceUseDecision: fabricatedDecision,
      sourceReferences: fabricatedDecision.references,
      sourceClaimBindings: [{
        claimId: 'claim-fabricated',
        mechanismStatus: 'corroborated',
        sourceReferenceIds: [sourceReference.id],
        traceEvidenceRefIds: ['trace-evidence-fabricated'],
        reason: 'SECRET_BINDING_REASON_CANARY',
      }],
      uncertainties: [],
      nextSteps: [],
    };

    expect(finalizeSourceResult(result, undefined)).toBe(result);

    expect(result.sourceUseDecision).toBeUndefined();
    expect(result.sourceReferences).toBeUndefined();
    expect(result.sourceClaimVerificationResult).toBeUndefined();
    expect(result.conclusionContract).not.toHaveProperty('sourceUseDecision');
    expect(result.conclusionContract).not.toHaveProperty('sourceReferences');
    expect(result.conclusionContract).not.toHaveProperty('sourceClaimBindings');
    expect(JSON.stringify(result)).not.toContain('SECRET_');
    expect(JSON.stringify(result)).not.toContain('/Users/chris');
  });

  test.each(['pending', 'attempted'] as const)(
    'blocks success while the actual source decision is %s',
    status => {
      const result = plainResult(`session-${status}`);
      const decision: SourceUseDecisionV1 = {
        schemaVersion: 'source_use_decision@1',
        codeAwareMode: 'provider_send',
        selectedCodebaseIds: ['codebase-task7'],
        status,
        attemptedTools: status === 'attempted' ? ['search_codebase'] : [],
        queriedCodebaseIds: status === 'attempted' ? ['codebase-task7'] : [],
        usedCodebaseIds: [],
        references: [],
      };

      finalizeSourceResult(result, {getSourceUseDecision: () => decision});

      expect(result).toMatchObject({
        success: false,
        partial: true,
        terminationReason: 'plan_incomplete',
        sourceUseDecision: expect.objectContaining({status}),
      });
      expect(result.terminationMessage).toBeUndefined();
    },
  );

  test('uses a real zero-index MCP search/read transition and sanitizes every returned model surface', async () => {
    const fixture = createRuntimeSourceFinalizationFixture({
      createMcpServer: createClaudeMcpServer,
      sessionId: 'session-real-handler-finalization',
    });
    try {
      expect(fixture.sourceUse.getSourceUseDecision()?.status).toBe('pending');
      const {decision, reference} = await fixture.executeProviderSourceLookup();
      expect(decision).toEqual(expect.objectContaining({
        status: 'corroborated',
        attemptedTools: expect.arrayContaining(['search_codebase', 'read_codebase_file']),
        queriedCodebaseIds: [fixture.codebaseId],
        usedCodebaseIds: [fixture.codebaseId],
      }));
      expect(reference).toEqual(expect.objectContaining({
        codebaseId: fixture.codebaseId,
        filePath: 'src/Task7Source.kt',
        lookupKind: 'body',
      }));

      const result = createSourceAuthoredAnalysisResult(fixture.sessionId);
      const finalized = finalizeSourceResult(result, fixture.sourceUse);
      const serialized = JSON.stringify(finalized);

      expect(finalized.success).toBe(true);
      expect(finalized.sourceUseDecision).toEqual(decision);
      expect(finalized.sourceReferences).toEqual(decision.references);
      expect(serialized).not.toContain(SOURCE_FINALIZATION_CANARY);
      expect(serialized).not.toContain(SOURCE_FINALIZATION_RAW_SOURCE);
      expect(finalized.findings[0]?.id).toBe('finding-task7');
      expect(finalized.hypotheses[0]?.id).toBe('hypothesis-task7');
      expect((finalized.findings[0]?.details as {traceId?: string}).traceId).toBe('trace-task7');

      const answer = projectCodeAwareStreamingUpdate(
        fixture.sessionId,
        {type: 'answer_token', content: SOURCE_FINALIZATION_RAW_SOURCE, timestamp: 1},
        true,
        'en',
      );
      const conclusion = projectCodeAwareStreamingUpdate(
        fixture.sessionId,
        {
          type: 'conclusion',
          content: {conclusion: SOURCE_FINALIZATION_RAW_SOURCE, success: true},
          timestamp: 2,
        },
        true,
        'en',
      );
      expect(JSON.stringify({answer, conclusion})).not.toContain(SOURCE_FINALIZATION_CANARY);
      expect(answer.content).toEqual({suppressed: true});
    } finally {
      fixture.cleanup();
    }
  });

  test('does not reuse a terminal accessor when the next run has no source selection', async () => {
    const fixture = createRuntimeSourceFinalizationFixture({
      createMcpServer: createClaudeMcpServer,
      sessionId: 'session-terminal-run',
    });
    try {
      await fixture.executeProviderSourceLookup();
      const terminal = finalizeSourceResult(plainResult(fixture.sessionId), fixture.sourceUse);
      const next = plainResult('session-source-off-run');
      const before = structuredClone(next);

      finalizeSourceResult(next, {getSourceUseDecision: () => undefined});

      expect(terminal.sourceUseDecision?.status).toBe('corroborated');
      expect(next).toEqual(before);
      expect(next.sourceUseDecision).toBeUndefined();
      expect(next.sourceReferences).toBeUndefined();
    } finally {
      fixture.cleanup();
    }
  });
});
