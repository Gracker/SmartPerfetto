// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import type {DataEnvelope} from '../../types/dataContract';
import type {RunManifestAttributionSink} from '../../types/selfEvolution';
import {RunManifestBuilder} from '../../services/selfEvolution/runManifestBuilder';
import {createAnalysisRunSpec} from '../analysisRunSpec';
import {
  buildAdaptiveRoutingPostEvidence,
  buildAdaptiveRoutingPreflight,
  recordAdaptiveRoutingPostEvidenceBestEffort,
} from '../adaptiveRoutingProjection';
import type {RuntimeSelection} from '../runtimeSelection';
import {buildQuickDirectAcknowledgementAnalysisResult} from '../quickDirectResult';
import {resolveQuickTurnBudget} from '../quickBudget';

const selection: RuntimeSelection = {
  kind: 'openai-agents-sdk',
  source: 'snapshot',
};

const result = (overrides: Partial<AnalysisResult> = {}): AnalysisResult => ({
  sessionId: 'session-a',
  success: true,
  findings: [],
  hypotheses: [],
  conclusion: 'Verified result.',
  confidence: 1,
  rounds: 2,
  totalDurationMs: 10,
  ...overrides,
});

const envelope = (
  overrides: Partial<DataEnvelope['meta']> = {},
): DataEnvelope => ({
  meta: {
    type: 'skill_result',
    version: '1',
    source: 'skill-a',
    timestamp: 1,
    executionStatus: 'observed',
    ...overrides,
  },
  data: {columns: ['value'], rows: [[1]]},
  display: {layer: 'list', format: 'table', title: 'Evidence'},
});

describe('adaptive routing runtime projection', () => {
  it('maps existing runtime flags without reading query text', () => {
    expect(buildAdaptiveRoutingPreflight({
      requestedMode: 'auto',
      resolvedMode: 'quick',
      classifierSource: 'hard_rule',
      quickAcknowledgementDirectAnswer: false,
      directEvidenceAvailable: true,
      hasReferenceTrace: false,
      privateContext: false,
      outputCap: 2_048,
    })).toMatchObject({
      currentTier: 'L0',
      reasons: ['deterministic_direct_evidence'],
      outputCap: 2_048,
    });
    expect(buildAdaptiveRoutingPreflight({
      requestedMode: 'fast',
      resolvedMode: 'quick',
      classifierSource: 'user_explicit',
      quickAcknowledgementDirectAnswer: false,
      directEvidenceAvailable: false,
      hasReferenceTrace: true,
      privateContext: false,
    })).toMatchObject({
      currentTier: 'L1',
      recommendedTier: 'L3',
      obligations: ['reference_comparison'],
    });
  });

  it('derives post-evidence counters only from structured contracts', () => {
    const previous = buildAdaptiveRoutingPreflight({
      requestedMode: 'auto',
      resolvedMode: 'quick',
      classifierSource: 'hard_rule',
      quickAcknowledgementDirectAnswer: false,
      directEvidenceAvailable: true,
      hasReferenceTrace: false,
      privateContext: false,
    });
    const post = buildAdaptiveRoutingPostEvidence({
      previous,
      result: result({
        claimVerificationResult: {
          schemaVersion: 'claim_verifier@1',
          status: 'failed',
          policy: 'record_only',
          passed: false,
          checkedClaimCount: 2,
          unsupportedClaimCount: 1,
          claimResults: [
            {claimId: 'a', status: 'verified'},
            {claimId: 'b', status: 'unsupported'},
          ],
          issues: [{
            claimId: 'b',
            severity: 'error',
            code: 'value_mismatch',
            message: 'private provider text must not be copied',
          }],
        },
        identityResolutions: [{
          version: 'identity_contract@1',
          identityRefId: 'identity-a',
          target: {traceId: 'trace-a', source: 'derived'},
          status: 'ambiguous',
          processes: [],
          threads: [],
          warnings: [],
        }],
        claimSupport: [{
          claimId: 'causal-a',
          kind: 'causal',
          text: 'private causal prose',
          anchors: [],
          supportLevel: 'inference',
          relationEvaluation: 'candidate',
        }],
        quickRun: {
          requestedMode: 'auto',
          resolvedMode: 'quick',
          profile: 'normal',
          targetTurns: 2,
          hardCapTurns: 4,
          actualTurns: 2,
          elapsedMs: 10,
          enforcement: 'turn_cap',
          stopReason: 'answered',
          evidence: {
            frontendPrequeryInjected: 0,
            frontendPrequeryCited: 0,
            currentRunDataEnvelopes: 1,
            citedEvidenceRefs: 1,
          },
          contextInjected: {
            conversationTurns: 0,
            recentSqlResults: 0,
            sqlPitfallPairs: 0,
            patternHints: 0,
            negativePatternHints: 0,
            caseBackgroundCases: 0,
          },
          verifierStatus: 'issues',
        },
      }),
      dataEnvelopes: [envelope({executionStatus: 'optional_error'})],
    });
    expect(post).toMatchObject({
      stage: 'post_evidence',
      evidence: {
        required: 2,
        observed: 1,
        missing: 1,
        unsupportedClaims: 1,
        conflicts: 1,
        identityStatus: 'ambiguous',
        schemaStatus: 'uncertain',
        causalOpen: 1,
      },
      budget: {dispatchUtilization: '50_79', repeatedToolCalls: 0},
      decision: 'recommend_upgrade',
      recommendedTier: 'L3',
    });
    expect(JSON.stringify(post)).not.toContain('private');
  });

  it('records the selected light model for quick and primary model for full', () => {
    for (const [resolvedMode, expectedModel] of [
      ['quick', 'flash-model'],
      ['full', 'pro-model'],
    ] as const) {
      const recordRuntime = jest.fn();
      const sink = {
        identity: {
          runId: `run-${resolvedMode}`,
          sessionId: `session-${resolvedMode}`,
          scope: {tenantId: 'local', workspaceId: 'local'},
        },
        recordScene: jest.fn(),
        recordRuntime,
        recordMode: jest.fn(),
      } as unknown as RunManifestAttributionSink;
      const spec = createAnalysisRunSpec({
        query: 'Analyze.',
        sessionId: `session-${resolvedMode}`,
        traceId: 'trace-a',
        options: {runManifestAttributionSink: sink},
        runtimeSelection: selection,
        sceneType: 'general',
        outputLanguage: 'en',
        resolvedMode,
        budget: {
          model: 'pro-model',
          lightModel: 'flash-model',
        },
      });
      expect(spec.runtime.actualModel).toBe(expectedModel);
      expect(recordRuntime).toHaveBeenCalledWith(expect.objectContaining({
        model: expectedModel,
      }));
    }
  });

  it('attributes zero-LLM acknowledgement to the runtime path, not the light model', () => {
    const recordRuntime = jest.fn();
    const sink = {
      identity: {
        runId: 'run-direct',
        sessionId: 'session-direct',
        scope: {tenantId: 'local', workspaceId: 'local'},
      },
      recordScene: jest.fn(),
      recordRuntime,
      recordMode: jest.fn(),
    } as unknown as RunManifestAttributionSink;
    const options = {runManifestAttributionSink: sink, analysisMode: 'fast' as const};
    const spec = createAnalysisRunSpec({
      query: 'Thanks.',
      sessionId: 'session-direct',
      traceId: 'trace-a',
      options,
      runtimeSelection: selection,
      sceneType: 'general',
      outputLanguage: 'en',
      resolvedMode: 'quick',
      budget: {model: 'pro-model', lightModel: 'flash-model'},
    });
    buildQuickDirectAcknowledgementAnalysisResult({
      sessionId: 'session-direct',
      options,
      outputLanguage: 'en',
      startedAt: Date.now(),
      analysisRunSpec: spec,
      budget: resolveQuickTurnBudget({targetTurns: 1, hardCapTurns: 1}),
      previousTurns: [],
    });
    expect(spec.runtime.actualModel).toBe('runtime-acknowledgement');
    expect(recordRuntime).toHaveBeenLastCalledWith(expect.objectContaining({
      model: 'runtime-acknowledgement',
    }));
  });

  it('keeps best-effort post routing failures from blocking manifest sealing', () => {
    const builder = new RunManifestBuilder({
      runId: 'run-a',
      sessionId: 'session-a',
      scope: {tenantId: 'local', workspaceId: 'local'},
      runtime: 'openai-agents-sdk',
      providerId: null,
      outputLanguage: 'en',
      analysisMode: 'auto',
      resolvedMode: 'quick',
    });
    builder.recordSkillRegistry({
      skills: [],
      registryFingerprint: 'a'.repeat(64),
      evolutionOverlayGeneration: `builtin:${'a'.repeat(64)}`,
    });
    builder.recordAdaptiveRouting(buildAdaptiveRoutingPreflight({
      requestedMode: 'auto',
      resolvedMode: 'quick',
      classifierSource: 'hard_rule',
      quickAcknowledgementDirectAnswer: false,
      directEvidenceAvailable: true,
      hasReferenceTrace: false,
      privateContext: false,
    }));
    const diagnostics: string[] = [];
    expect(recordAdaptiveRoutingPostEvidenceBestEffort({
      builder,
      result: result(),
      dataEnvelopes: [],
      onDiagnostic: code => diagnostics.push(code),
    })).toBe(true);
    expect(builder.currentAdaptiveRouting?.stage).toBe('post_evidence');
    expect(builder.seal().adaptiveRouting?.stage).toBe('post_evidence');

    expect(recordAdaptiveRoutingPostEvidenceBestEffort({
      builder,
      result: result(),
      dataEnvelopes: [],
      onDiagnostic: code => diagnostics.push(code),
    })).toBe(false);
    expect(diagnostics).toContain('adaptive_routing_post_evidence_skipped');
  });
});
