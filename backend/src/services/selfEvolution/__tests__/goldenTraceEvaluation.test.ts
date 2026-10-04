// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {EvalGroundTruthV1} from '../../../types/selfEvolution';
import type {
  ClaimSupportV1,
} from '../../../types/evidenceContract';
import type {RunManifestV1} from '../../../types/selfEvolution';
import {
  parseEvalGroundTruth,
  parseGoldenTraceObservation,
  scoreGoldenTraceObservation,
} from '../goldenTraceScorer';
import {
  buildGoldenTraceObservationFromAnalysis,
} from '../goldenTraceObservationBuilder';

const emptyGroundTruth = (
  overrides: Partial<EvalGroundTruthV1> = {},
): EvalGroundTruthV1 => ({
  schemaVersion: 1,
  requiredFacts: [],
  numericExpectations: [],
  requiredEvidence: [],
  forbiddenClaims: [],
  allowedGaps: [],
  identityExpectations: [],
  causalEdges: [],
  ...overrides,
});

const emptyObservation = () => ({
  schemaVersion: 1 as const,
  facts: {},
  evidence: [] as string[],
  claims: [] as Array<{
    text: string;
    supportLevel: 'verified' | 'partial' | 'inference' | 'unsupported';
  }>,
  gaps: [] as Array<{code: string; missingEvidenceIds: string[]}>,
  identities: {} as Record<string, string | number | boolean | null>,
  causalEdges: [] as Array<{
    subject: string;
    relation: string;
    object: string;
    level: 'correlation' | 'mechanism';
    verified: boolean;
  }>,
});

describe('golden trace evaluation contracts', () => {
  it('strictly validates deterministic fact and tolerance contracts', () => {
    const parsed = parseEvalGroundTruth(emptyGroundTruth({
      requiredFacts: [{
        id: 'fact-a',
        statement: 'The signal exists.',
        evaluation: 'deterministic',
        observationKey: 'signal.0.type',
        expected: 'anr-event',
      }],
      numericExpectations: [{
        id: 'duration-a',
        observationKey: 'signal.0.duration_ns',
        expected: 1_000,
        unit: 'ns',
        absoluteTolerance: 10,
      }],
    }));
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(parsed.requiredFacts[0].observationKey).toBe('signal.0.type');

    expect(() => parseEvalGroundTruth({
      ...emptyGroundTruth(),
      unknown: true,
    })).toThrow('eval_ground_truth_unknown_field');
    expect(() => parseEvalGroundTruth(emptyGroundTruth({
      requiredFacts: [{
        id: 'fact-a',
        statement: 'Missing deterministic binding.',
        evaluation: 'deterministic',
      } as never],
    }))).toThrow('eval_required_fact_deterministic_binding_invalid');
    expect(() => parseEvalGroundTruth(emptyGroundTruth({
      numericExpectations: [{
        id: 'duration-a',
        observationKey: 'duration',
        expected: 1,
        unit: 'ms',
      } as never],
    }))).toThrow('eval_numeric_tolerance_required');
    expect(() => parseGoldenTraceObservation({
      ...emptyObservation(),
      unknown: true,
    })).toThrow('golden_trace_observation_unknown_field');
  });
});

describe('golden trace deterministic scorer', () => {
  it('never passes without ground truth', () => {
    expect(scoreGoldenTraceObservation(undefined, emptyObservation())).toEqual({
      status: 'inconclusive',
      reason: 'ground_truth_missing',
    });
  });

  it('scores keyed facts, numeric tolerance, evidence, identity, gaps, and causal edges', () => {
    const groundTruth = emptyGroundTruth({
      requiredFacts: [
        {
          id: 'event-kind',
          statement: 'ANR event exists.',
          evaluation: 'deterministic',
          observationKey: 'signal.0.type',
          expected: 'anr-event',
        },
        {
          id: 'semantic-root-cause',
          statement: 'Explain the verified root cause.',
          evaluation: 'semantic',
        },
      ],
      numericExpectations: [{
        id: 'duration',
        observationKey: 'signal.0.duration_ns',
        expected: 1_000,
        unit: 'ns',
        absoluteTolerance: 10,
      }],
      requiredEvidence: [{
        id: 'anr-sql',
        kind: 'coverage_expectation',
        locator: 'binder-io-blocking:execute-anr_analysis',
      }],
      forbiddenClaims: [{
        id: 'temporal-causality',
        contains: ['temporal proximity proves causality'],
        reason: 'Timing alone is not a mechanism.',
      }],
      allowedGaps: [{
        id: 'gpu-gap',
        code: 'gpu_evidence_missing',
        requiresMissingEvidence: ['gpu-track'],
      }],
      identityExpectations: [{
        id: 'target-process',
        observationKey: 'signal.0.target_process',
        expected: 'app',
      }],
      causalEdges: [{
        id: 'anr-trigger',
        subject: 'anr',
        relation: 'triggered_by',
        object: 'blocking-chain',
        minimumLevel: 'mechanism',
      }],
    });
    const observation = emptyObservation();
    observation.facts = {
      'signal.0.type': {
        value: 'anr-event',
        evidenceIds: ['data:anr'],
      },
      'signal.0.duration_ns': {
        value: 1_008,
        unit: 'ns',
        evidenceIds: ['data:anr'],
      },
    };
    observation.evidence = ['binder-io-blocking:execute-anr_analysis'];
    observation.gaps = [{
      code: 'gpu_evidence_missing',
      missingEvidenceIds: ['gpu-track'],
    }];
    observation.identities = {'signal.0.target_process': 'app'};
    observation.causalEdges = [{
      subject: 'anr',
      relation: 'triggered_by',
      object: 'blocking-chain',
      level: 'mechanism',
      verified: true,
    }];

    const result = scoreGoldenTraceObservation(groundTruth, observation);
    expect(result).toMatchObject({
      status: 'scored',
      passed: false,
      blockers: ['semantic_fact_not_evaluated'],
      summary: {
        failed: 0,
        notEvaluable: 1,
      },
    });
    expect(result.status === 'scored' ? result.assertions : []).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'event-kind',
          status: 'passed',
        }),
        expect.objectContaining({
          id: 'semantic-root-cause',
          status: 'not_evaluable',
        }),
      ]),
    );
    expect(result.status === 'scored' && result.contentHash).toHaveLength(64);
  });

  it.each([
    ['unit mismatch', (observation: ReturnType<typeof emptyObservation>) => {
      observation.facts = {
        duration: {value: 100, unit: 'ms', evidenceIds: ['data:duration']},
      };
    }, 'numeric_unit_mismatch'],
    ['forbidden claim', (observation: ReturnType<typeof emptyObservation>) => {
      observation.claims = [{
        text: 'Temporal proximity proves causality here.',
        supportLevel: 'unsupported',
      }];
    }, 'forbidden_claim'],
    ['wrong identity', (observation: ReturnType<typeof emptyObservation>) => {
      observation.identities = {target: 'wrong-app'};
    }, 'identity_mismatch'],
    ['unknown gap', (observation: ReturnType<typeof emptyObservation>) => {
      observation.gaps = [{code: 'unknown-gap', missingEvidenceIds: []}];
    }, 'invalid_gap'],
    ['missing causal edge', (_observation: ReturnType<typeof emptyObservation>) => {}, 'causal_edge_missing'],
    ['unsupported claim', (observation: ReturnType<typeof emptyObservation>) => {
      observation.claims = [{
        text: 'The trace proves a root cause without evidence.',
        supportLevel: 'unsupported',
      }];
    }, 'unsupported_claim'],
  ])('blocks %s', (_label, mutate, expectedBlocker) => {
    const observation = emptyObservation();
    mutate(observation);
    const groundTruth = emptyGroundTruth({
      numericExpectations: [{
        id: 'duration',
        observationKey: 'duration',
        expected: 100,
        unit: 'ns',
        absoluteTolerance: 0,
      }],
      forbiddenClaims: [{
        id: 'forbidden',
        contains: ['temporal proximity proves causality'],
        reason: 'No mechanism.',
      }],
      allowedGaps: [{
        id: 'allowed',
        code: 'allowed-gap',
        requiresMissingEvidence: ['missing-a'],
      }],
      identityExpectations: [{
        id: 'identity',
        observationKey: 'target',
        expected: 'app',
      }],
      causalEdges: [{
        id: 'edge',
        subject: 'a',
        relation: 'causes',
        object: 'b',
        minimumLevel: 'mechanism',
      }],
    });

    const result = scoreGoldenTraceObservation(groundTruth, observation);
    expect(result).toMatchObject({status: 'scored', passed: false});
    expect(result.status === 'scored' ? result.blockers : [])
      .toContain(expectedBlocker);
  });
});

describe('golden trace production observation builder', () => {
  it('projects only verified structured cells and sealed runtime attribution', () => {
    const groundTruth = emptyGroundTruth({
      requiredFacts: [{
        id: 'event-kind',
        statement: 'Startup event exists.',
        evaluation: 'deterministic',
        observationKey: 'signal.0.type',
        expected: 'startup',
      }],
      numericExpectations: [{
        id: 'duration',
        observationKey: 'signal.0.duration_ns',
        expected: 1_000,
        unit: 'ns',
        absoluteTolerance: 0,
      }],
      requiredEvidence: [{
        id: 'execute-startup_analysis',
        kind: 'coverage_expectation',
        locator: 'startup-lifecycle:execute-startup_analysis',
      }],
      identityExpectations: [{
        id: 'event-name',
        observationKey: 'signal.0.name',
        expected: 'Launch',
      }],
    });
    const claimSupport: ClaimSupportV1[] = [{
      claimId: 'claim-a',
      kind: 'categorical',
      text: 'A verified startup event was observed.',
      supportLevel: 'verified',
      anchors: [{
        anchorId: 'anchor-a',
        version: 'evidence_contract@1',
        evidenceRefId: 'evidence-a',
        context: {
          traceId: 'trace-a',
          producerKind: 'invoke_skill',
          skillId: 'startup_analysis',
        },
        cells: [
          {column: 'type', actualValue: 'startup'},
          {column: 'duration_ns', actualValue: 1_000, unit: 'ns'},
          {column: 'name', actualValue: 'Launch'},
        ],
      }],
    }];
    const manifest = {
      strategyId: 'startup',
      sceneType: 'startup',
      skills: [{
        skillId: 'startup_analysis',
        invocations: 1,
        okCount: 1,
      }],
    } as RunManifestV1;
    const observation = buildGoldenTraceObservationFromAnalysis({
      evalCase: {
        schemaVersion: 1,
        caseId: 'case-a',
        evalSetId: 'set-a',
        origin: 'manual_golden',
        scope: {tenantId: 'local', workspaceId: 'local'},
        traces: [{
          role: 'current',
          catalogAlias: 'startup-lifecycle',
          contentHash: 'a'.repeat(64),
        }],
        query: 'Analyze startup.',
        analysisMode: 'full',
        split: 'validation',
        createdAt: '2026-08-22T00:00:00.000Z',
        groundTruth,
      },
      runManifest: manifest,
      claimSupport,
    });

    expect(observation).toMatchObject({
      facts: {
        'signal.0.type': {value: 'startup', evidenceIds: ['evidence-a']},
        'signal.0.duration_ns': {
          value: 1_000,
          unit: 'ns',
          evidenceIds: ['evidence-a'],
        },
      },
      evidence: ['startup-lifecycle:execute-startup_analysis'],
      identities: {'signal.0.name': 'Launch'},
      claims: [{
        text: 'A verified startup event was observed.',
        supportLevel: 'verified',
      }],
    });
    expect(scoreGoldenTraceObservation(groundTruth, observation!))
      .toMatchObject({status: 'scored', passed: true});
  });
});
