// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {buildQuickRunReceipt, resolveQuickTurnBudget} from '../quickBudget';
import {
  parseAdaptiveRoutingReceipt,
  routeAdaptiveEvidencePostEvidence,
  routeAdaptiveEvidencePreflight,
} from '../adaptiveEvidenceRouter';
import {createAnalysisRunSpec} from '../analysisRunSpec';
import type {RuntimeSelection} from '../runtimeSelection';
import {RunManifestBuilder} from '../../services/selfEvolution/runManifestBuilder';
import {buildAnalysisReceipt} from '../../services/analysisReceiptBuilder';
import type {RunManifestAttributionSink} from '../../types/selfEvolution';
import {canonicalContentHash} from '../../services/selfEvolution/canonicalJson';

const selection: RuntimeSelection = {
  kind: 'openai-agents-sdk',
  source: 'snapshot',
};

const direct = () => routeAdaptiveEvidencePreflight({
  requestedMode: 'auto',
  resolvedMode: 'quick',
  classifierIntent: 'deterministic_direct_evidence',
  classifierSource: 'hard_rule',
  hardObligations: [],
  outputCap: 2_048,
});

describe('adaptive evidence shadow router', () => {
  it('keeps deterministic direct evidence at L0 without changing public mode', () => {
    expect(direct()).toMatchObject({
      schemaVersion: 'adaptive_routing@1',
      requestedMode: 'auto',
      resolvedMode: 'quick',
      currentTier: 'L0',
      recommendedTier: 'L0',
      decision: 'stay',
      reasons: ['deterministic_direct_evidence'],
      shadow: true,
      outputCap: 2_048,
    });
  });

  it('does not call an empty deterministic result evidence-sufficient', () => {
    const empty = routeAdaptiveEvidencePostEvidence({
      previous: direct(),
      evidence: {
        required: 0,
        observed: 0,
        unsupportedClaims: 0,
        conflicts: 0,
        identityStatus: 'unknown',
        schemaStatus: 'unknown',
        causalOpen: 0,
      },
      dispatchBudgetRatio: 0,
      repeatedToolCalls: 0,
    });

    expect(empty).toMatchObject({
      decision: 'recommend_upgrade',
      recommendedTier: 'L3',
      reasons: ['capability_uncertain'],
      obligations: ['schema_resolution'],
    });
    expect(empty.reasons).not.toContain('evidence_sufficient');
  });

  it('allows acknowledgement-only runs to complete without trace evidence', () => {
    const acknowledgement = routeAdaptiveEvidencePreflight({
      requestedMode: 'auto',
      resolvedMode: 'quick',
      classifierIntent: 'acknowledgement',
      classifierSource: 'hard_rule',
      hardObligations: [],
    });
    expect(routeAdaptiveEvidencePostEvidence({
      previous: acknowledgement,
      evidence: {
        required: 0,
        observed: 0,
        unsupportedClaims: 0,
        conflicts: 0,
        identityStatus: 'unknown',
        schemaStatus: 'unknown',
        causalOpen: 0,
      },
      dispatchBudgetRatio: 0,
      repeatedToolCalls: 0,
    })).toMatchObject({
      decision: 'stay',
      recommendedTier: 'L0',
      reasons: ['evidence_sufficient'],
    });
  });

  it.each([
    ['reference_comparison'],
    ['private_context'],
    ['cross_process_causality'],
  ] as const)('recommends L3 for non-downgrade obligation %s', obligation => {
    const receipt = routeAdaptiveEvidencePreflight({
      requestedMode: 'fast',
      resolvedMode: 'quick',
      classifierIntent: 'semantic_quick',
      classifierSource: 'user_explicit',
      hardObligations: [obligation],
    });
    expect(receipt).toMatchObject({
      resolvedMode: 'quick',
      currentTier: 'L1',
      recommendedTier: 'L3',
      decision: 'recommend_upgrade',
      obligations: [obligation],
      shadow: true,
    });
  });

  it('uses L2 for ordinary full semantic work and L3 for explicit full report', () => {
    expect(routeAdaptiveEvidencePreflight({
      requestedMode: 'auto',
      resolvedMode: 'full',
      classifierIntent: 'semantic_full',
      classifierSource: 'ai',
      hardObligations: [],
    })).toMatchObject({currentTier: 'L2', recommendedTier: 'L2'});
    expect(routeAdaptiveEvidencePreflight({
      requestedMode: 'full',
      resolvedMode: 'full',
      classifierIntent: 'semantic_full',
      classifierSource: 'user_explicit',
      hardObligations: ['complete_report'],
    })).toMatchObject({
      currentTier: 'L3',
      recommendedTier: 'L3',
      reasons: ['user_requested_full'],
    });
  });

  it('recommends evidence-driven upgrades but returns GAP at L3 or 80% dispatch budget', () => {
    const identityConflict = routeAdaptiveEvidencePostEvidence({
      previous: direct(),
      evidence: {
        required: 3,
        observed: 1,
        unsupportedClaims: 1,
        conflicts: 0,
        identityStatus: 'conflict',
        schemaStatus: 'ready',
        causalOpen: 0,
      },
      dispatchBudgetRatio: 0.4,
      repeatedToolCalls: 0,
    });
    expect(identityConflict).toMatchObject({
      stage: 'post_evidence',
      recommendedTier: 'L3',
      decision: 'recommend_upgrade',
      reasons: expect.arrayContaining([
        'identity_conflict',
        'unsupported_claim',
        'required_evidence_missing',
      ]),
    });

    const atBudget = routeAdaptiveEvidencePostEvidence({
      previous: direct(),
      evidence: {
        required: 2,
        observed: 1,
        unsupportedClaims: 0,
        conflicts: 0,
        identityStatus: 'verified',
        schemaStatus: 'ready',
        causalOpen: 0,
      },
      dispatchBudgetRatio: 0.8,
      repeatedToolCalls: 1,
    });
    expect(atBudget).toMatchObject({
      decision: 'return_gap',
      recommendedTier: 'L0',
      reasons: expect.arrayContaining(['budget_dispatch_threshold']),
    });

    const atL3 = routeAdaptiveEvidencePostEvidence({
      previous: routeAdaptiveEvidencePreflight({
        requestedMode: 'full',
        resolvedMode: 'full',
        classifierIntent: 'semantic_full',
        classifierSource: 'user_explicit',
        hardObligations: ['complete_report'],
      }),
      evidence: {
        required: 1,
        observed: 0,
        unsupportedClaims: 0,
        conflicts: 0,
        identityStatus: 'not_required',
        schemaStatus: 'ready',
        causalOpen: 0,
      },
      dispatchBudgetRatio: 0.2,
      repeatedToolCalls: 0,
    });
    expect(atL3.decision).toBe('return_gap');
  });

  it('preserves pending hard upgrades while allowing a satisfied L3 run to stop', () => {
    const pending = routeAdaptiveEvidencePostEvidence({
      previous: routeAdaptiveEvidencePreflight({
        requestedMode: 'fast',
        resolvedMode: 'quick',
        classifierIntent: 'semantic_quick',
        classifierSource: 'user_explicit',
        hardObligations: ['reference_comparison'],
      }),
      evidence: {
        required: 1,
        observed: 1,
        unsupportedClaims: 0,
        conflicts: 0,
        identityStatus: 'verified',
        schemaStatus: 'ready',
        causalOpen: 0,
      },
      dispatchBudgetRatio: 0.2,
      repeatedToolCalls: 0,
    });
    expect(pending).toMatchObject({
      decision: 'recommend_upgrade',
      recommendedTier: 'L3',
      reasons: ['reference_comparison', 'evidence_sufficient'],
    });

    const satisfied = routeAdaptiveEvidencePostEvidence({
      previous: routeAdaptiveEvidencePreflight({
        requestedMode: 'full',
        resolvedMode: 'full',
        classifierIntent: 'semantic_full',
        classifierSource: 'user_explicit',
        hardObligations: ['complete_report'],
      }),
      evidence: {
        required: 2,
        observed: 2,
        unsupportedClaims: 0,
        conflicts: 0,
        identityStatus: 'verified',
        schemaStatus: 'ready',
        causalOpen: 0,
      },
      dispatchBudgetRatio: 0.4,
      repeatedToolCalls: 0,
    });
    expect(satisfied).toMatchObject({
      currentTier: 'L3',
      decision: 'stay',
      reasons: ['evidence_sufficient'],
    });
  });

  it('strictly hashes receipts and rejects unknown/free-form payload fields', () => {
    const receipt = direct();
    expect(parseAdaptiveRoutingReceipt(receipt)).toEqual(receipt);
    expect(() => parseAdaptiveRoutingReceipt({
      ...receipt,
      query: 'private package com.secret.app',
    } as never)).toThrow('adaptive_routing_unknown_field');
    expect(() => parseAdaptiveRoutingReceipt({
      ...receipt,
      contentHash: 'f'.repeat(64),
    })).toThrow('adaptive_routing_content_hash_mismatch');
    const {contentHash: _hash, ...body} = receipt;
    const nestedUnknown = {
      ...body,
      evidence: {...receipt.evidence, privateValue: 'secret'},
    };
    expect(() => parseAdaptiveRoutingReceipt({
      ...nestedUnknown,
      contentHash: canonicalContentHash(nestedUnknown),
    })).toThrow('adaptive_routing_nested_contract_invalid');
  });
});

describe('adaptive routing persistence seams', () => {
  it('persists an optional receipt in RunManifest without changing mode', () => {
    const builder = new RunManifestBuilder({
      runId: 'run-routing',
      sessionId: 'session-routing',
      scope: {tenantId: 'local', workspaceId: 'local'},
      runtime: 'openai-agents-sdk',
      providerId: null,
      model: 'model-a',
      outputLanguage: 'en',
      analysisMode: 'auto',
      resolvedMode: 'quick',
    });
    builder.recordSkillRegistry({
      skills: [],
      registryFingerprint: 'a'.repeat(64),
      evolutionOverlayGeneration: `builtin:${'a'.repeat(64)}`,
    });
    builder.recordAdaptiveRouting(direct());
    const manifest = builder.seal();
    expect(manifest).toMatchObject({
      analysisMode: 'auto',
      resolvedMode: 'quick',
      adaptiveRouting: {currentTier: 'L0', decision: 'stay'},
    });
  });

  it('keeps AnalysisRunSpec optional and calls only the optional routing sink seam', () => {
    const recordAdaptiveRouting = jest.fn();
    const sink = {
      identity: {
        runId: 'run-routing',
        sessionId: 'session-routing',
        scope: {tenantId: 'local', workspaceId: 'local'},
      },
      recordScene: jest.fn(),
      recordRuntime: jest.fn(),
      recordMode: jest.fn(),
      recordAdaptiveRouting,
    } as unknown as RunManifestAttributionSink;
    const without = createAnalysisRunSpec({
      query: 'fact',
      sessionId: 'session-a',
      traceId: 'trace-a',
      runtimeSelection: selection,
      sceneType: 'general',
      outputLanguage: 'en',
    });
    expect(without.mode).not.toHaveProperty('adaptiveRouting');

    const receipt = direct();
    const withRouting = createAnalysisRunSpec({
      query: 'fact',
      sessionId: 'session-routing',
      traceId: 'trace-a',
      options: {runManifestAttributionSink: sink},
      runtimeSelection: selection,
      sceneType: 'general',
      outputLanguage: 'en',
      resolvedMode: 'quick',
      adaptiveRouting: receipt,
    });
    expect(withRouting.mode.adaptiveRouting).toEqual(receipt);
    expect(recordAdaptiveRouting).toHaveBeenCalledWith(receipt);
  });

  it('projects routing into quick and final analysis receipts', () => {
    const adaptiveRouting = direct();
    const quick = buildQuickRunReceipt({
      requestedMode: 'auto',
      resolvedMode: 'quick',
      budget: resolveQuickTurnBudget({targetTurns: 1, hardCapTurns: 2}),
      actualTurns: 0,
      elapsedMs: 10,
      stopReason: 'answered',
      adaptiveRouting,
    });
    expect(quick.adaptiveRouting).toEqual(adaptiveRouting);

    const finalReceipt = buildAnalysisReceipt({
      runManifestId: 'manifest-routing',
      session: {sessionId: 'session-routing', traceId: 'trace-routing'},
      result: {
        sessionId: 'session-routing',
        success: true,
        findings: [],
        hypotheses: [],
        conclusion: 'Verified fact.',
        confidence: 1,
        rounds: 0,
        totalDurationMs: 10,
        quickRun: quick,
      },
      adaptiveRouting,
      generatedAt: 10,
    });
    expect(finalReceipt.adaptiveRouting).toEqual(adaptiveRouting);
    expect(JSON.stringify(finalReceipt)).not.toContain('private package');
  });
});
