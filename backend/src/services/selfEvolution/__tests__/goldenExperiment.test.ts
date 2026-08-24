// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import fs from 'fs';
import os from 'os';
import path from 'path';

import type {
  EvalPinnedEnvironmentV1,
} from '../../../types/selfEvolution';
import {canonicalContentHash} from '../canonicalJson';
import {
  compileGoldenExperimentManifest,
  type GoldenExperimentProfileV1,
} from '../goldenExperimentContracts';
import {
  GoldenExperimentArtifactStore,
} from '../goldenExperimentArtifactStore';
import {
  runGoldenExperiment,
  summarizeGoldenExperiment,
  type GoldenExperimentCellResultV1,
} from '../goldenExperimentRunner';
import {
  loadGoldenTraceRegistry,
  type GoldenTraceRegistryV1,
} from '../goldenTraceRegistry';
import {
  recordEvaluationFirstOutput,
  recordEvaluationFirstOutputNotApplicable,
  recordEvaluationObservedUsageDelta,
  recordEvaluationTermination,
  recordTraceProcessorCpuSample,
  snapshotEvaluationUsageReceipt,
  withEvaluationTelemetry,
  type EvaluationUsageReceiptV1,
} from '../evaluationTelemetry';
import {evaluationRuntimeCapabilities} from '../evaluationRuntimeCapabilities';

const pinned = (
  model: string,
  runtime: EvalPinnedEnvironmentV1['runtime'] = 'openai-agents-sdk',
): EvalPinnedEnvironmentV1 => ({
  runtime,
  providerId: `provider-${model}`,
  model,
  outputLanguage: 'zh-CN',
  toolAllowlistHash: canonicalContentHash(['query_trace']),
  injections: 'off',
  overlayGeneration: 'builtin:registry',
});

const budget = {
  schemaVersion: 1 as const,
  maxTokens: 20_000,
  maxToolCalls: 40,
  maxWallclockMs: 300_000,
  maxTraceProcessorCpuMs: 120_000,
};

const profile = (
  profileId: string,
  model: string,
  analysisMode: 'fast' | 'full' = 'full',
): GoldenExperimentProfileV1 => ({
  profileId,
  pinned: pinned(model),
  analysisMode,
  budget,
});

async function usageReceipt(input: {
  tokens?: number;
  wallclockMs?: number;
  firstOutputMs?: number;
  terminationReason?: string;
} = {}): Promise<EvaluationUsageReceiptV1> {
  let now = 1_000;
  return withEvaluationTelemetry({
    limits: budget,
    capabilities: evaluationRuntimeCapabilities({
      runtime: 'openai-agents-sdk',
      platform: 'linux',
    }),
    signal: new AbortController().signal,
    isAuthoritative: () => true,
    now: () => now,
  }, async () => {
    recordEvaluationObservedUsageDelta({
      total: input.tokens ?? 100,
      input: 60,
      output: 30,
      cacheRead: 10,
      reasoning: 5,
    });
    now += input.firstOutputMs ?? 20;
    recordEvaluationFirstOutput();
    now = 1_000 + (input.wallclockMs ?? 100);
    recordEvaluationTermination(input.terminationReason ?? 'completed');
    recordTraceProcessorCpuSample({
      cumulativeCpuMs: 10,
      platform: 'linux',
      sampleIntervalMs: 250,
      staleThresholdMs: 1_000,
      logicalCpuCount: 4,
    });
    return snapshotEvaluationUsageReceipt();
  });
}

function oneCaseRegistry(): GoldenTraceRegistryV1 {
  return {
    schemaVersion: 1,
    evalSetId: 'test-golden-v1',
    cases: [{
      schemaVersion: 1,
      caseId: 'golden-case-a',
      evalSetId: 'test-golden-v1',
      origin: 'manual_golden',
      scope: {tenantId: 'local', workspaceId: 'local'},
      traces: [{
        role: 'current',
        catalogAlias: 'startup-lifecycle',
        contentHash: 'a'.repeat(64),
      }],
      query: 'Analyze the startup event.',
      analysisMode: 'full',
      expectedScene: 'startup',
      goldenPoints: ['Explain the verified startup bottleneck.'],
      split: 'validation',
      createdAt: '2026-08-22T00:00:00.000Z',
      catalogAlias: 'startup-lifecycle',
      groundTruth: {
        schemaVersion: 1,
        requiredFacts: [{
          id: 'event-kind',
          statement: 'Startup event exists.',
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
    }],
  };
}

describe('golden experiment manifest compiler', () => {
  it('records component usage, first output, and termination in one receipt', async () => {
    const receipt = await usageReceipt({
      tokens: 100,
      firstOutputMs: 25,
      wallclockMs: 90,
      terminationReason: 'plan_complete',
    });
    expect(receipt).toMatchObject({
      tokens: {
        used: 100,
        breakdown: {
          input: 60,
          output: 30,
          cacheRead: 10,
          cacheWrite: 0,
          reasoning: 5,
          unclassified: 0,
        },
      },
      firstOutput: {usedMs: 25, guarantee: 'observed'},
      termination: {reason: 'plan_complete', guarantee: 'observed'},
      wallclock: {usedMs: 90},
    });
  });

  it('distinguishes provider-free fast completion from missing TTFT telemetry', async () => {
    const controller = new AbortController();
    const receipt = await withEvaluationTelemetry({
      limits: budget,
      capabilities: evaluationRuntimeCapabilities({
        runtime: 'openai-agents-sdk',
        platform: 'linux',
      }),
      signal: controller.signal,
      isAuthoritative: () => true,
    }, async () => {
      recordEvaluationObservedUsageDelta({total: 1});
      recordTraceProcessorCpuSample({cumulativeCpuMs: 1, platform: 'linux'});
      recordEvaluationFirstOutputNotApplicable();
      recordEvaluationTermination('completed');
      return snapshotEvaluationUsageReceipt();
    });
    expect(receipt.firstOutput).toEqual({guarantee: 'not_applicable'});
  });

  it('builds provider-free PR cells without serializing oracle content', () => {
    const registry = loadGoldenTraceRegistry();
    const manifest = compileGoldenExperimentManifest({
      tier: 'pr',
      registry,
      profiles: [],
      createdAt: '2026-08-22T00:00:00.000Z',
    });
    expect(manifest.cells).toHaveLength(12);
    expect(manifest.cells.every(cell =>
      cell.execution === 'deterministic_contract'
      && cell.profileId === null
      && cell.repeat === 1)).toBe(true);
    const serialized = JSON.stringify(manifest);
    for (const evalCase of registry.cases) {
      for (const fact of evalCase.groundTruth.requiredFacts) {
        expect(serialized).not.toContain(fact.statement);
      }
      for (const point of evalCase.goldenPoints ?? []) {
        expect(serialized).not.toContain(point);
      }
    }
  });

  it('expands nightly cells with three repeats and excludes holdout', () => {
    const registry = loadGoldenTraceRegistry();
    const profiles = [
      profile('deepseek-fast', 'deepseek-chat', 'fast'),
      profile('deepseek-full', 'deepseek-chat', 'full'),
    ];
    const input = {
      tier: 'nightly' as const,
      registry,
      profiles,
      repeats: 3,
      baselineProfileId: 'deepseek-full',
      createdAt: '2026-08-22T00:00:00.000Z',
    };
    const first = compileGoldenExperimentManifest(input);
    const second = compileGoldenExperimentManifest(input);
    expect(first).toEqual(second);
    expect(first.cases.every(item => item.split !== 'holdout')).toBe(true);
    expect(first.cases).toHaveLength(9);
    expect(first.cells).toHaveLength(9 * 2 * 3);
    expect(new Set(first.cells.map(cell => cell.cellId)).size)
      .toBe(first.cells.length);
    expect(first.policy).toMatchObject({concurrency: 1, repeats: 3});
  });

  it('enforces release/nightly provider and repeat policy', () => {
    const registry = loadGoldenTraceRegistry();
    expect(() => compileGoldenExperimentManifest({
      tier: 'nightly',
      registry,
      profiles: [profile('only', 'deepseek-chat')],
      repeats: 2,
      createdAt: '2026-08-22T00:00:00.000Z',
    })).toThrow('golden_experiment_provider_repeats_invalid');
    expect(() => compileGoldenExperimentManifest({
      tier: 'release',
      registry,
      profiles: [],
      repeats: 3,
      createdAt: '2026-08-22T00:00:00.000Z',
    })).toThrow('golden_experiment_profiles_required');
  });
});

describe('golden experiment runner and artifacts', () => {
  it('keeps oracle fields outside the executor and rejoins them only for scoring', async () => {
    const registry = oneCaseRegistry();
    const manifest = compileGoldenExperimentManifest({
      tier: 'nightly',
      registry,
      profiles: [profile('baseline', 'deepseek-chat')],
      repeats: 3,
      baselineProfileId: 'baseline',
      createdAt: '2026-08-22T00:00:00.000Z',
    });
    const observedInputs: string[] = [];
    const result = await runGoldenExperiment({
      manifest,
      registry,
      executor: {
        execute: async input => {
          observedInputs.push(JSON.stringify(input.executionCase));
          return {
            status: 'completed',
            observation: {
              schemaVersion: 1,
              facts: {
                'signal.0.type': {
                  value: 'startup',
                  evidenceIds: ['evidence-a'],
                },
              },
              evidence: [],
              claims: [],
              gaps: [],
              identities: {},
              causalEdges: [],
            },
            usageReceipt: await usageReceipt(),
            actual: {
              runtime: input.profile.pinned.runtime,
              providerId: input.profile.pinned.providerId,
              model: input.profile.pinned.model,
              terminationReason: 'completed',
            },
          };
        },
      },
      semanticJudge: {
        judge: async input => ({
          status: 'scored',
          hitRatio: input.goldenPoints.length > 0 ? 1 : 0,
          judgeReceiptHash: 'b'.repeat(64),
        }),
      },
    });
    expect(result.results).toHaveLength(3);
    expect(result.results.every(item =>
      item.status === 'completed'
      && item.goldenScore?.passed
      && item.semanticScore?.hitRatio === 1)).toBe(true);
    for (const serialized of observedInputs) {
      expect(serialized).not.toContain('groundTruth');
      expect(serialized).not.toContain('goldenPoints');
      expect(serialized).not.toContain('Startup event exists.');
      expect(serialized).not.toContain('Explain the verified startup bottleneck.');
    }
  });

  it('records unavailable provider cells instead of skipping them', async () => {
    const registry = oneCaseRegistry();
    const manifest = compileGoldenExperimentManifest({
      tier: 'release',
      registry: {
        ...registry,
        cases: registry.cases.map(item => ({...item, split: 'holdout'})),
      },
      profiles: [profile('qoder', 'qoder-default', 'full')],
      repeats: 3,
      baselineProfileId: 'qoder',
      createdAt: '2026-08-22T00:00:00.000Z',
    });
    const result = await runGoldenExperiment({
      manifest,
      registry: {
        ...registry,
        cases: registry.cases.map(item => ({...item, split: 'holdout'})),
      },
      executor: {
        execute: async () => ({
          status: 'unavailable',
          reason: 'runtime_not_available',
        }),
      },
    });
    expect(result.results).toHaveLength(3);
    expect(result.results.every(item =>
      item.status === 'unavailable'
      && item.reason === 'runtime_not_available')).toBe(true);
    expect(result.summary.cells.unavailable).toBe(3);
  });

  it('rejects a tampered manifest and an invalid usage receipt', async () => {
    const registry = oneCaseRegistry();
    const manifest = compileGoldenExperimentManifest({
      tier: 'nightly',
      registry,
      profiles: [profile('baseline', 'deepseek-chat')],
      repeats: 3,
      baselineProfileId: 'baseline',
      createdAt: '2026-08-22T00:00:00.000Z',
    });
    await expect(runGoldenExperiment({
      manifest: {...manifest, cells: [...manifest.cells].reverse()},
      registry,
      executor: {execute: async () => ({
        status: 'unavailable',
        reason: 'runtime_not_available',
      })},
    })).rejects.toThrow('golden_experiment_manifest_invalid');

    const receipt = await usageReceipt();
    const result = await runGoldenExperiment({
      manifest,
      registry,
      executor: {
        execute: async input => ({
          status: 'completed',
          observation: {
            schemaVersion: 1,
            facts: {
              'signal.0.type': {value: 'startup', evidenceIds: []},
            },
            evidence: [],
            claims: [],
            gaps: [],
            identities: {},
            causalEdges: [],
          },
          usageReceipt: {...receipt, contentHash: 'c'.repeat(64)},
          actual: {
            runtime: input.profile.pinned.runtime,
            providerId: input.profile.pinned.providerId,
            model: input.profile.pinned.model,
            terminationReason: 'completed',
          },
        }),
      },
    });
    expect(result.results.every(item =>
      item.status === 'inconclusive'
      && item.reason === 'golden_experiment_usage_receipt_invalid')).toBe(true);
  });

  it('persists hash/count observation receipts without claim text or values', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-experiment-'));
    try {
      const registry = oneCaseRegistry();
      const manifest = compileGoldenExperimentManifest({
        tier: 'nightly',
        registry,
        profiles: [profile('baseline', 'deepseek-chat')],
        repeats: 3,
        baselineProfileId: 'baseline',
        createdAt: '2026-08-22T00:00:00.000Z',
      });
      const store = new GoldenExperimentArtifactStore({root: directory});
      await runGoldenExperiment({
        manifest,
        registry,
        artifactStore: store,
        executor: {
          execute: async input => ({
            status: 'completed',
            observation: {
              schemaVersion: 1,
              facts: {
                'signal.0.type': {
                  value: 'private-startup-value',
                  evidenceIds: ['private-evidence'],
                },
              },
              evidence: [],
              claims: [{
                text: 'private model conclusion text',
                supportLevel: 'verified',
              }],
              gaps: [],
              identities: {'private-process': 'secret.process'},
              causalEdges: [],
            },
            usageReceipt: await usageReceipt(),
            actual: {
              runtime: input.profile.pinned.runtime,
              providerId: input.profile.pinned.providerId,
              model: input.profile.pinned.model,
              terminationReason: 'completed',
            },
          }),
        },
      });
      const experimentRoot = path.join(directory, manifest.experimentId);
      const persisted = fs.readFileSync(path.join(
        experimentRoot,
        'cells',
        manifest.cells[0].cellId,
        'observation-receipt.json',
      ), 'utf8');
      expect(persisted).not.toContain('private-startup-value');
      expect(persisted).not.toContain('private model conclusion text');
      expect(persisted).not.toContain('secret.process');
      expect(JSON.parse(persisted)).toMatchObject({
        facts: 1,
        claims: 1,
        identities: 1,
      });
    } finally {
      fs.rmSync(directory, {recursive: true, force: true});
    }
  });

  it('rejects an intermediate symlink escape in the artifact tree', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-artifacts-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'golden-outside-'));
    try {
      const manifest = compileGoldenExperimentManifest({
        tier: 'pr',
        registry: oneCaseRegistry(),
        profiles: [],
        createdAt: '2026-08-22T00:00:00.000Z',
      });
      const store = new GoldenExperimentArtifactStore({root: directory});
      store.writeManifest(manifest);
      fs.symlinkSync(
        outside,
        path.join(directory, manifest.experimentId, 'cells'),
        'dir',
      );
      expect(() => store.writeCell({
        experimentId: manifest.experimentId,
        result: {
          schemaVersion: 1,
          cellId: manifest.cells[0].cellId,
          caseId: manifest.cells[0].caseId,
          profileId: null,
          repeat: 1,
          status: 'completed',
          contentHash: 'd'.repeat(64),
        },
      })).toThrow('golden_experiment_artifact_directory_invalid');
    } finally {
      fs.rmSync(directory, {recursive: true, force: true});
      fs.rmSync(outside, {recursive: true, force: true});
    }
  });
});

describe('golden experiment summary', () => {
  it('reports percentiles and paired outcome buckets', () => {
    const cell = (input: {
      cellId: string;
      profileId: string;
      repeat: number;
      passed: boolean;
      tokens: number;
    }): GoldenExperimentCellResultV1 => ({
      schemaVersion: 1,
      cellId: input.cellId,
      caseId: 'case-a',
      profileId: input.profileId,
      repeat: input.repeat,
      status: 'completed',
      goldenScore: {
        passed: input.passed,
        assertionCount: 1,
        passedAssertions: input.passed ? 1 : 0,
        failedAssertions: input.passed ? 0 : 1,
        notEvaluableAssertions: 0,
        blockers: input.passed ? [] : ['deterministic_fact_mismatch'],
        contentHash: canonicalContentHash(input),
      },
      usage: {
        tokens: input.tokens,
        wallclockMs: input.tokens * 2,
        firstOutputMs: input.tokens / 10,
      },
      contentHash: canonicalContentHash({...input, result: true}),
    });
    const results = [
      cell({cellId: 'b1', profileId: 'baseline', repeat: 1, passed: false, tokens: 100}),
      cell({cellId: 'c1', profileId: 'candidate', repeat: 1, passed: true, tokens: 80}),
      cell({cellId: 'b2', profileId: 'baseline', repeat: 2, passed: true, tokens: 120}),
      cell({cellId: 'c2', profileId: 'candidate', repeat: 2, passed: true, tokens: 90}),
      cell({cellId: 'b3', profileId: 'baseline', repeat: 3, passed: true, tokens: 140}),
      cell({cellId: 'c3', profileId: 'candidate', repeat: 3, passed: false, tokens: 110}),
    ];
    const summary = summarizeGoldenExperiment({
      baselineProfileId: 'baseline',
      results,
    });
    expect(summary.comparison).toMatchObject({
      improved: 1,
      regressed: 1,
      unchanged: 1,
      notEvaluable: 0,
    });
    expect(summary.profiles.candidate).toMatchObject({
      medianTokens: 90,
      p90Tokens: 110,
      p95Tokens: 110,
      failureRate: 1 / 3,
    });
  });
});
