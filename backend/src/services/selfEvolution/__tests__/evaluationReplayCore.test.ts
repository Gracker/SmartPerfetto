// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  EvalCaseV1,
  EvalPinnedEnvironmentV1,
  EvalScoreV1,
  RunInjectionAttribution,
  RunManifestV1,
} from '../../../types/selfEvolution';
import type {ClaimVerificationResult} from '../../../types/claimVerification';
import {canonicalContentHash} from '../canonicalJson';
import {
  assertEvaluationExposureMatchesContract,
  commitEvaluationExposureSince,
  createEvaluationRoleInjectionContract,
  isEvaluationInjectionAllowed,
  registerEvaluationInjection,
  sealEvaluationExposureReceipt,
  withEvaluationInjectionContext,
} from '../evaluationInjectionContext';
import {
  preflightEvaluationBudgets,
  recordEvaluationObservedTokenTotal,
  recordEvaluationToolCall,
  recordTraceProcessorCpuSample,
  snapshotEvaluationUsageReceipt,
  withEvaluationTelemetry,
  type EvaluationUsageReceiptV1,
} from '../evaluationTelemetry';
import {evaluationRuntimeCapabilities} from '../evaluationRuntimeCapabilities';
import {
  freezeEvaluationArtifacts,
  scoreFrozenEvaluationArtifacts,
} from '../evalScorer';
import {paretoCompareEvalScores} from '../paretoCompare';
import {
  attestEvaluationPair,
  createEvaluationMaterializationProof,
  createEvaluationRoleProofV2,
} from '../evaluationPairAttestation';
import {
  __testing as environmentTesting,
  normalizeEvaluationInjectionSelector,
  type EvaluationEnvironmentProofV1,
} from '../evaluationEnvironmentProof';
import {TraceProcessorCpuSampler, __testing as cpuTesting} from '../traceProcessorCpuSampler';

const scope = {tenantId: 'local', workspaceId: 'local'};
const EMPTY_INJECTIONS: RunInjectionAttribution = {
  patterns: [],
  skillNotes: [],
  cases: [],
  phaseHints: [],
  knowledgeDocs: [],
};
const pinned: EvalPinnedEnvironmentV1 = {
  runtime: 'openai-agents-sdk',
  providerId: null,
  model: 'gpt-eval',
  outputLanguage: 'zh-CN',
  toolAllowlistHash: canonicalContentHash(['query_trace']),
  injections: 'on',
  overlayGeneration: 'builtin:registry',
};
const treatmentRef = {
  category: 'phaseHints' as const,
  id: 'candidate-phase-hint',
  contentHash: 'a'.repeat(64),
};

function evalCase(overrides: Partial<EvalCaseV1> = {}): EvalCaseV1 {
  return {
    schemaVersion: 1,
    caseId: 'case-a',
    evalSetId: 'set-a',
    origin: 'synthetic_seed',
    scope,
    traces: [{
      role: 'current',
      corpusId: 'b'.repeat(64),
      contentHash: 'b'.repeat(64),
    }],
    query: 'Analyze startup latency.',
    analysisMode: 'full',
    split: 'validation',
    createdAt: '2026-07-29T00:00:00.000Z',
    ...overrides,
  };
}

function manifest(role: 'baseline' | 'candidate'): RunManifestV1 {
  const injections = role === 'candidate'
    ? {
        ...EMPTY_INJECTIONS,
        phaseHints: [{
          id: treatmentRef.id,
          contentHash: treatmentRef.contentHash,
        }],
      }
    : EMPTY_INJECTIONS;
  return {
    schemaVersion: 1,
    runManifestId: `manifest-${role}`,
    runId: `run-${role}`,
    sessionId: `session-${role}`,
    sealedAt: 1,
    scope,
    sceneType: 'startup',
    promptTemplateHashes: [],
    skills: [],
    skillRegistryFingerprint: 'registry',
    evolutionOverlayGeneration: pinned.overlayGeneration,
    sqlStatementCount: 1,
    sqlErrorCount: 0,
    runtime: pinned.runtime,
    providerId: pinned.providerId,
    model: pinned.model,
    outputLanguage: pinned.outputLanguage,
    toolAllowlistHash: pinned.toolAllowlistHash,
    featureFlagSnapshot: {},
    analysisMode: 'full',
    resolvedMode: 'full',
    capabilityFlags: [],
    injections,
    turns: 2,
    wallclockMs: 100,
  };
}

function verification(): ClaimVerificationResult {
  return {
    schemaVersion: 'claim_verifier@1',
    status: 'passed',
    policy: 'record_only',
    passed: true,
    checkedClaimCount: 1,
    unsupportedClaimCount: 0,
    claimResults: [{
      claimId: 'claim-a',
      status: 'verified',
      referenceResults: [
        {
          status: 'matched',
          evidenceRefId: 'evidence-a',
          sourceToolCallId: 'tool-a',
        },
        {
          status: 'matched',
          evidenceRefId: 'evidence-a',
          artifactId: 'artifact-a',
        },
      ],
    }],
    issues: [],
  };
}

async function usageReceipt(): Promise<EvaluationUsageReceiptV1> {
  let now = 100;
  return withEvaluationTelemetry({
    limits: {
      schemaVersion: 1,
      maxTokens: 100,
      maxToolCalls: 10,
      maxWallclockMs: 1_000,
      maxTraceProcessorCpuMs: 1_000,
    },
    capabilities: evaluationRuntimeCapabilities({
      runtime: pinned.runtime,
      platform: 'linux',
    }),
    signal: new AbortController().signal,
    isAuthoritative: () => true,
    now: () => now,
  }, async () => {
    recordEvaluationObservedTokenTotal(12);
    recordEvaluationToolCall();
    recordTraceProcessorCpuSample({
      cumulativeCpuMs: 25,
      platform: 'linux',
      sampleIntervalMs: 250,
      staleThresholdMs: 1_000,
      logicalCpuCount: 4,
    });
    now = 150;
    return snapshotEvaluationUsageReceipt();
  });
}

function baseProof(
  role: 'baseline' | 'candidate',
): EvaluationEnvironmentProofV1 {
  const injections = manifest(role).injections;
  const generation = {
    schemaVersion: 1 as const,
    entries: [{
      scope: {
        level: 'local' as const,
        tenantId: 'local',
        workspaceId: null,
        userId: null,
      },
      revision: 0,
      inFlight: 0,
    }],
  };
  const generationFingerprint = canonicalContentHash(generation);
  const selector = normalizeEvaluationInjectionSelector({
    schemaVersion: 1,
    mode: pinned.injections,
    selected: injections,
  });
  const injectionSetHash = canonicalContentHash(injections);
  const selectorFingerprint = canonicalContentHash(selector);
  const withoutHash: Omit<EvaluationEnvironmentProofV1, 'contentHash'> = {
    schemaVersion: 1,
    proofId: `proof-${role}`,
    runId: `run-${role}`,
    runManifestId: `manifest-${role}`,
    evaluationStartContentHash: 'c'.repeat(64),
    scope,
    pinned,
    providerSnapshotHash: 'd'.repeat(64),
    providerMutationGeneration: generation,
    providerMutationGenerationFingerprint: generationFingerprint,
    injections,
    injectionSetHash,
    injectionSelectorConfigFingerprint: selectorFingerprint,
    environmentFingerprint: environmentTesting.environmentFingerprint({
      pinned,
      providerSnapshotHash: 'd'.repeat(64),
      providerMutationGenerationFingerprint: generationFingerprint,
      injectionSelectorConfigFingerprint: selectorFingerprint,
    }),
    capturedAt: '2026-07-29T00:00:01.000Z',
  };
  return {
    ...withoutHash,
    contentHash: environmentTesting.proofContentHash(withoutHash),
  };
}

describe('evaluation replay core', () => {
  it('accounts all four budgets and makes unsupported strict runs inconclusive', async () => {
    const receipt = await usageReceipt();
    expect(receipt).toMatchObject({
      tokens: {used: 12, guarantee: 'soft_observed'},
      toolCalls: {used: 1, guarantee: 'hard'},
      wallclock: {usedMs: 50, guarantee: 'hard'},
      traceProcessorCpu: {
        usedMs: 25,
        guarantee: 'soft_observed',
        maxTheoreticalOvershootMs: 4_000,
      },
      exceeded: null,
    });
    expect(preflightEvaluationBudgets({
      capabilities: evaluationRuntimeCapabilities({
        runtime: pinned.runtime,
        platform: 'linux',
      }),
      strict: true,
    })).toEqual({
      status: 'inconclusive',
      reasons: [
        'token_budget_not_hard_bounded',
        'trace_processor_cpu_not_hard_bounded',
        'provider_request_exposure_not_observable',
      ],
    });
  });

  it('keeps materialization separate from observed SDK exposure', async () => {
    const candidateContract = createEvaluationRoleInjectionContract({
      role: 'candidate',
      mode: 'on',
      selected: {
        ...EMPTY_INJECTIONS,
        phaseHints: [{
          id: treatmentRef.id,
          contentHash: treatmentRef.contentHash,
        }],
      },
      reservedTreatmentNamespace: [treatmentRef],
      expectedMaterializedRefs: [treatmentRef],
      expectedObservedRefs: [{
        ref: treatmentRef,
        minimumGuarantee: 'sdk_handoff_observed',
      }],
      forbiddenObservedRefs: [],
    });
    await withEvaluationInjectionContext({
      contract: candidateContract,
    }, async () => {
      expect(registerEvaluationInjection({
        ...treatmentRef,
        placement: 'system_prompt',
      })).toMatchObject({allowed: true, classification: 'treatment'});
      commitEvaluationExposureSince(0, 'sdk_handoff_observed');
      const receipt = sealEvaluationExposureReceipt();
      expect(() => assertEvaluationExposureMatchesContract({
        contract: candidateContract,
        receipt,
      })).not.toThrow();
      expect(receipt.observed[0].guarantee).toBe('sdk_handoff_observed');
    });

    const offContract = createEvaluationRoleInjectionContract({
      role: 'candidate',
      mode: 'off',
      selected: EMPTY_INJECTIONS,
      reservedTreatmentNamespace: [treatmentRef],
      expectedMaterializedRefs: [treatmentRef],
      expectedObservedRefs: [],
      forbiddenObservedRefs: [treatmentRef],
    });
    await withEvaluationInjectionContext({contract: offContract}, async () => {
      expect(isEvaluationInjectionAllowed(treatmentRef)).toBe(false);
    });
  });

  it('scores one frozen artifact deterministically with L0, L1, and L3 only', async () => {
    const artifacts = freezeEvaluationArtifacts({
      schemaVersion: 1,
      evalCase: evalCase(),
      runManifest: manifest('candidate'),
      pinned,
      role: 'candidate',
      attempt: 1,
      candidateId: 'candidate-a',
      runOk: true,
      reportContractPass: true,
      claimVerificationResult: verification(),
      usageReceipt: await usageReceipt(),
    });
    const first = scoreFrozenEvaluationArtifacts(artifacts);
    const second = scoreFrozenEvaluationArtifacts(artifacts);
    expect(first).toEqual(second);
    expect(first.status).toBe('scored');
    if (first.status !== 'scored') return;
    expect(first.score.l1).toEqual({
      claimVerifiedRatio: 1,
      unsupportedClaims: 0,
      evidenceAnchors: 1,
    });
    expect(first.score).not.toHaveProperty('l2');
  });

  it('makes golden replay inconclusive without an observation and persists a passing score when present', async () => {
    const goldenCase = evalCase({
      groundTruth: {
        schemaVersion: 1,
        requiredFacts: [{
          id: 'fact-a',
          statement: 'The startup signal exists.',
          evaluation: 'deterministic',
          observationKey: 'signal.0.type',
          expected: 'startup',
        }],
        numericExpectations: [],
        requiredEvidence: [],
        forbiddenClaims: [],
        allowedGaps: [],
        identityExpectations: [],
        causalEdges: [],
      },
    });
    const common = {
      schemaVersion: 1 as const,
      evalCase: goldenCase,
      runManifest: manifest('candidate'),
      pinned,
      role: 'candidate' as const,
      attempt: 1,
      candidateId: 'candidate-a',
      runOk: true,
      reportContractPass: true,
      claimVerificationResult: verification(),
      usageReceipt: await usageReceipt(),
    };
    expect(scoreFrozenEvaluationArtifacts(
      freezeEvaluationArtifacts(common),
    )).toMatchObject({
      status: 'inconclusive',
      reason: 'golden_trace_observation_missing',
    });

    const scored = scoreFrozenEvaluationArtifacts(freezeEvaluationArtifacts({
      ...common,
      goldenTraceObservation: {
        schemaVersion: 1,
        facts: {
          'signal.0.type': {
            value: 'startup',
            evidenceIds: ['data:startup'],
          },
        },
        evidence: [],
        claims: [],
        gaps: [],
        identities: {},
        causalEdges: [],
      },
    }));
    expect(scored).toMatchObject({
      status: 'scored',
      score: {
        golden: {
          passed: true,
          assertionCount: 1,
          passedAssertions: 1,
          failedAssertions: 0,
          notEvaluableAssertions: 0,
        },
      },
    });
  });

  it('returns inconclusive for hash-valid malformed nested artifacts', async () => {
    const malformed = freezeEvaluationArtifacts({
      schemaVersion: 1,
      evalCase: {
        ...evalCase(),
        scope: null,
      } as never,
      runManifest: manifest('candidate'),
      pinned,
      role: 'candidate',
      attempt: 1,
      candidateId: 'candidate-a',
      runOk: true,
      reportContractPass: true,
      claimVerificationResult: verification(),
      usageReceipt: await usageReceipt(),
    });

    expect(() => scoreFrozenEvaluationArtifacts(malformed)).not.toThrow();
    expect(scoreFrozenEvaluationArtifacts(malformed)).toMatchObject({
      status: 'inconclusive',
      frozenArtifactsHash: malformed.contentHash,
    });
  });

  it('fails closed for malformed claim-verifier enums and invariants', async () => {
    const base = verification();
    const malformedResults: ClaimVerificationResult[] = [
      {
        ...base,
        claimResults: [{
          ...base.claimResults[0],
          referenceResults: [{
            status: 'invented_status',
            evidenceRefId: 'evidence-a',
          }],
        }],
      } as never,
      {
        ...base,
        checkedClaimCount: 2,
        claimResults: [
          base.claimResults[0],
          {...base.claimResults[0]},
        ],
      },
      {
        ...base,
        claimResults: [{
          ...base.claimResults[0],
          status: 'partial',
        }],
      },
      {
        ...base,
        claimResults: [{
          ...base.claimResults[0],
          referenceResults: [{
            status: 'missing',
            evidenceRefId: 'evidence-a',
            message: 'missing evidence',
          }],
        }],
      },
      {
        schemaVersion: 'claim_verifier@1',
        status: 'not_checked',
        policy: 'record_only',
        notCheckedReason: 'no structured claims',
        passed: false,
        checkedClaimCount: 0,
        unsupportedClaimCount: 0,
        claimResults: [],
        issues: [],
      },
      {
        ...base,
        issues: [{
          claimId: 'claim-a',
          severity: 'warning',
          code: 'identity_not_verified',
          message: 'identity support is incomplete',
        }],
      },
      {
        ...base,
        status: 'partial',
        passed: false,
        claimResults: [{
          ...base.claimResults[0],
          status: 'partial',
          referenceResults: [{
            status: 'not_checked',
            evidenceRefId: 'evidence-a',
            message: 'expected value unavailable',
          }],
        }],
      },
      {
        ...base,
        issues: [{
          claimId: 'unknown-claim',
          severity: 'warning',
          code: 'orphan_issue',
          message: 'issue is not bound to a checked claim',
        }],
      },
    ];

    for (const claimVerificationResult of malformedResults) {
      const artifacts = freezeEvaluationArtifacts({
        schemaVersion: 1,
        evalCase: evalCase(),
        runManifest: manifest('candidate'),
        pinned,
        role: 'candidate',
        attempt: 1,
        candidateId: 'candidate-a',
        runOk: true,
        reportContractPass: true,
        claimVerificationResult,
        usageReceipt: await usageReceipt(),
      });
      expect(scoreFrozenEvaluationArtifacts(artifacts)).toMatchObject({
        status: 'inconclusive',
        frozenArtifactsHash: artifacts.contentHash,
      });
    }
  });

  it('attests a pair only after role-specific exposure contracts pass', async () => {
    const baselineContract = createEvaluationRoleInjectionContract({
      role: 'baseline',
      mode: 'on',
      selected: EMPTY_INJECTIONS,
      reservedTreatmentNamespace: [treatmentRef],
      expectedMaterializedRefs: [],
      expectedObservedRefs: [],
      forbiddenObservedRefs: [treatmentRef],
    });
    const candidateContract = createEvaluationRoleInjectionContract({
      role: 'candidate',
      mode: 'on',
      selected: {
        ...EMPTY_INJECTIONS,
        phaseHints: [{
          id: treatmentRef.id,
          contentHash: treatmentRef.contentHash,
        }],
      },
      reservedTreatmentNamespace: [treatmentRef],
      expectedMaterializedRefs: [treatmentRef],
      expectedObservedRefs: [{
        ref: treatmentRef,
        minimumGuarantee: 'sdk_handoff_observed',
      }],
      forbiddenObservedRefs: [],
    });
    const baselineReceipt = await withEvaluationInjectionContext({
      contract: baselineContract,
    }, async () => sealEvaluationExposureReceipt());
    const candidateReceipt = await withEvaluationInjectionContext({
      contract: candidateContract,
    }, async () => {
      registerEvaluationInjection({...treatmentRef, placement: 'system_prompt'});
      commitEvaluationExposureSince(0, 'sdk_handoff_observed');
      return sealEvaluationExposureReceipt();
    });
    const commonBaseHash = 'e'.repeat(64);
    const candidateContentHash = '5'.repeat(64);
    const treatmentArtifactContentHash = '6'.repeat(64);
    const materializedInputHash = '7'.repeat(64);
    const baselineProof = createEvaluationRoleProofV2({
      role: 'baseline',
      baseProof: baseProof('baseline'),
      contract: baselineContract,
      materialization: createEvaluationMaterializationProof({
        artifactId: 'baseline:candidate-a',
        sourceCandidateContentHash: candidateContentHash,
        treatmentArtifactContentHash,
        materializedInputHash,
        baseRegistryContentHash: commonBaseHash,
        persistentOverlayGeneration: pinned.overlayGeneration,
        treatmentGeneration: 'evaluation:baseline',
        materializedRefs: [],
        effectiveSkillRegistryFingerprint: 'f'.repeat(64),
        effectiveStrategyRegistryFingerprint: '1'.repeat(64),
      }),
      exposureReceipt: baselineReceipt,
      commonBaseRegistryContentHash: commonBaseHash,
    });
    const candidateProof = createEvaluationRoleProofV2({
      role: 'candidate',
      baseProof: baseProof('candidate'),
      contract: candidateContract,
      materialization: createEvaluationMaterializationProof({
        artifactId: 'candidate-a',
        sourceCandidateContentHash: candidateContentHash,
        treatmentArtifactContentHash,
        materializedInputHash,
        baseRegistryContentHash: commonBaseHash,
        persistentOverlayGeneration: pinned.overlayGeneration,
        treatmentGeneration: 'evaluation:candidate',
        materializedRefs: [treatmentRef],
        effectiveSkillRegistryFingerprint: '2'.repeat(64),
        effectiveStrategyRegistryFingerprint: '3'.repeat(64),
      }),
      exposureReceipt: candidateReceipt,
      commonBaseRegistryContentHash: commonBaseHash,
    });
    expect(attestEvaluationPair({
      baseline: baselineProof,
      candidate: candidateProof,
      baselineContract,
      candidateContract,
      fullTreatmentContractHash: '4'.repeat(64),
    })).toMatchObject({
      commonBaseRegistryContentHash: commonBaseHash,
      ambientObservedHash: canonicalContentHash([]),
    });
  });

  it('uses Pareto directions and treats missing resources as inconclusive', () => {
    const baseline: EvalScoreV1 = {
      schemaVersion: 1,
      caseId: 'case-a',
      evalSetId: 'set-a',
      runId: 'baseline',
      runManifestId: 'manifest-baseline',
      attempt: 1,
      role: 'baseline',
      scope,
      pinned,
      availability: 'available',
      l0: {
        runOk: true,
        sqlErrorFree: true,
        reportContractPass: true,
        skillCrashFree: true,
      },
      l1: {
        claimVerifiedRatio: 0.8,
        unsupportedClaims: 1,
        evidenceAnchors: 2,
      },
      l3: {
        turns: 3,
        wallclockMs: 1_000,
        estimatedTokens: 100,
        toolCalls: 4,
      },
    };
    const candidate: EvalScoreV1 = {
      ...baseline,
      runId: 'candidate',
      runManifestId: 'manifest-candidate',
      role: 'candidate',
      candidateId: 'candidate-a',
      l1: {
        claimVerifiedRatio: 0.9,
        unsupportedClaims: 0,
        evidenceAnchors: 3,
      },
      l3: {
        turns: 2,
        wallclockMs: 900,
        estimatedTokens: 90,
        toolCalls: 3,
      },
    };
    expect(paretoCompareEvalScores({baseline, candidate}))
      .toMatchObject({status: 'comparable', relation: 'candidate_dominates'});
    expect(paretoCompareEvalScores({candidate}))
      .toEqual({status: 'inconclusive', reason: 'score_unavailable'});
  });

  it('samples cumulative trace-processor CPU across stable PIDs', () => {
    expect(cpuTesting.parseProcessTime('01:02.5')).toBe(62_500);
    const values = new Map<number, number>([[10, 100], [20, 200]]);
    const samples: number[] = [];
    const sampler = new TraceProcessorCpuSampler({
      resolvePids: () => [20, 10],
      readProcessCpuMs: pid => values.get(pid),
      recordSample: value => samples.push(value),
      platform: 'linux',
    });
    expect(sampler.sample()).toBe(0);
    values.set(10, 150);
    values.set(20, 240);
    expect(sampler.sample()).toBe(90);
    expect(samples).toEqual([0, 90]);
  });
});
