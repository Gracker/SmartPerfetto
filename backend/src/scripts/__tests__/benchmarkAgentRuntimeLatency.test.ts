// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'crypto';
import {EventEmitter} from 'events';
import fs from 'fs';
import fsp from 'fs/promises';
import http from 'http';
import os from 'os';
import path from 'path';
import {PassThrough} from 'stream';

import type {ConclusionContract} from '../../agent/core/conclusionContract';
import type {RuntimePerformanceReceiptV1} from '../../agentRuntime/runtimePerformance';
import {PRODUCTION_RUNTIME_KINDS} from '../../agentRuntime/runtimeKinds';
import {
  CANDIDATE_TARGET_PHASES,
  aggregateCandidateAdmissions,
  assertPairedBenchmarkCells,
  buildDirectHttpRequestOptions,
  buildSyntheticScorerMatrix,
  buildRuntimeBenchmarkQuality,
  buildSemanticFingerprint,
  inspectLocalRuntimeAvailability,
  parseAgentLatencyArgs,
  parseExternalLifecycleReceipt,
  parseRuntimeBenchmarkArtifact,
  parseRuntimeBenchmarkCell,
  prepareBenchmarkOutputDirectory,
  directHttpResponse,
  readBoundedJsonResponse,
  runTargetBenchmarkCell,
  runAgentLatencyBenchmark,
  scoreCandidateAdmission as scoreCandidateAdmissionContract,
  type BenchmarkCandidate,
  type BenchmarkSampleKind,
  type RuntimeBenchmarkArtifactV1,
  type RuntimeBenchmarkCell,
  writeBenchmarkJsonAtomic,
} from '../benchmarkAgentRuntimeLatency';

const basePerformance: RuntimePerformanceReceiptV1 = {
  schemaVersion: 1,
  firstOutputMs: 1_000,
  phases: [
    {name: 'quick_evidence', startOffsetMs: 0, durationMs: 400, outcome: 'ok'},
    {name: 'focus', startOffsetMs: 0, durationMs: 200, outcome: 'ok'},
    {name: 'classification', startOffsetMs: 0, durationMs: 300, outcome: 'ok'},
    {name: 'comparison', startOffsetMs: 300, durationMs: 200, outcome: 'ok'},
    {name: 'skill_registry', startOffsetMs: 500, durationMs: 300, outcome: 'ok'},
    {name: 'knowledge', startOffsetMs: 500, durationMs: 200, outcome: 'ok'},
    {name: 'sdk_start', startOffsetMs: 700, durationMs: 500, outcome: 'ok'},
    {name: 'provider', startOffsetMs: 1_200, durationMs: 1_200, outcome: 'ok'},
    {name: 'verification', startOffsetMs: 2_400, durationMs: 300, outcome: 'ok'},
    {name: 'correction', startOffsetMs: 2_700, durationMs: 300, outcome: 'ok'},
  ],
  tools: [],
  sql: [],
};

const candidatePerformance: RuntimePerformanceReceiptV1 = {
  ...basePerformance,
  firstOutputMs: 850,
  phases: basePerformance.phases.map(phase => ({
    ...phase,
    durationMs: Math.round(phase.durationMs * 0.65),
  })),
};

const CANDIDATE_CONFIG_FINGERPRINT = 'b'.repeat(64);

function conclusionContract(overrides: Partial<ConclusionContract> = {}): ConclusionContract {
  return {
    schemaVersion: 'conclusion_contract_v1',
    mode: 'initial_report',
    conclusions: [
      {rank: 1, statement: 'Main-thread startup work is the primary root cause.'},
      {rank: 2, statement: 'Binder contention is secondary.'},
    ],
    clusters: [],
    evidenceChain: [
      {conclusionId: 'root-main-thread', text: 'prose excluded from fingerprint'},
      {conclusionId: 'root-binder', text: 'more prose excluded from fingerprint'},
    ],
    claims: [
      {
        id: 'claim-main-thread',
        conclusionId: 'root-main-thread',
        text: 'Main thread is blocked for 400ms.',
        kind: 'causal',
        references: [{evidenceRefId: 'data:startup:main', sourceRef: 'sql:startup'}],
      },
      {
        id: 'claim-binder',
        conclusionId: 'root-binder',
        text: 'Binder contention is secondary.',
        kind: 'causal',
        references: [{evidenceRefId: 'data:startup:binder', sourceRef: 'sql:binder'}],
      },
    ],
    uncertainties: [],
    nextSteps: [],
    ...overrides,
  };
}

function quality() {
  return buildRuntimeBenchmarkQuality({
    conclusionContract: conclusionContract(),
    analysisReceipt: {
      claimAudit: {verifiedClaims: 2, unsupportedClaims: 0},
      qualityGates: {
        finalReportContract: 'passed',
        claimVerification: 'passed',
        identityResolution: 'passed',
      },
    },
    claimVerificationResult: {
      status: 'passed',
      checkedClaimCount: 2,
      unsupportedClaimCount: 0,
    },
    identityResolutions: [{
      identityRefId: 'identity:app-main',
      status: 'verified',
      target: {traceId: 'trace', role: 'app_main'},
    }],
    sourceClaimBindings: [],
  });
}

function providerUsage() {
  return {
    inputTokens: 1_000,
    outputTokens: 500,
    cacheReadTokens: 100,
    reasoningTokens: 50,
    costUsd: 0.02,
  };
}

function cell(overrides: Partial<RuntimeBenchmarkCell> = {}): RuntimeBenchmarkCell {
  return {
    candidate: 'task6',
    executionProvenance: 'genuine_adapter',
    candidateConfigFingerprint: CANDIDATE_CONFIG_FINGERPRINT,
    runtime: 'openai-agents-sdk',
    providerId: 'provider-deepseek',
    model: 'deepseek-v4-pro',
    providerSnapshotHash: 'sha256:0123456789abcdef0123456789abcdef',
    trace: 'android-startup-heavy',
    queryHash: 'a'.repeat(64),
    mode: 'full',
    scenario: 'startup-full',
    repetition: 1,
    warmup: false,
    cacheState: 'warm',
    acceptedAtMs: 0,
    firstOutputMs: 1_000,
    terminalMs: 4_000,
    performance: basePerformance,
    providerUsage: providerUsage(),
    targetBinding: {
      uploadedTraceId: 'trace-uploaded',
      receiptTraceId: 'trace-uploaded',
      analyzeSessionId: 'session-1',
      receiptSessionId: 'session-1',
      analyzeRunId: 'run-1',
      terminalRunId: 'run-1',
      receiptRunId: 'run-1',
      requestedQueryHash: 'a'.repeat(64),
      observedQueryHash: 'a'.repeat(64),
      requestedMode: 'full',
      observedMode: 'full',
      resolvedMode: 'full',
      requestedCandidateId: 'task6',
      requestedCandidateConfigFingerprint: CANDIDATE_CONFIG_FINGERPRINT,
      observedCandidateId: 'task6',
      observedCandidateConfigFingerprint: CANDIDATE_CONFIG_FINGERPRINT,
      observedTargetConfigHash: '6'.repeat(64),
      observedSourceHash: '8'.repeat(64),
    },
    cleanup: {
      session: {attempted: true, success: true, status: 200},
      trace: {attempted: true, success: true, status: 200},
    },
    terminalOutcome: 'completed',
    quality: quality(),
    ...overrides,
  };
}

function artifact(
  role: 'base' | 'candidate',
  cells: RuntimeBenchmarkCell[],
  overrides: Partial<RuntimeBenchmarkArtifactV1['lifecycle']> = {},
): RuntimeBenchmarkArtifactV1 {
  const targetConfigHash = role === 'base' ? '6'.repeat(64) : '7'.repeat(64);
  const sourceHash = role === 'base' ? '8'.repeat(64) : '9'.repeat(64);
  const boundCells = cells.map(entry => ({
    ...entry,
    targetBinding: {
      ...entry.targetBinding,
      observedTargetConfigHash: targetConfigHash,
      observedSourceHash: sourceHash,
    },
  }));
  const measured = boundCells.filter(entry => !entry.warmup);
  const warmups = boundCells.filter(entry => entry.warmup);
  const pairEntry = (entry: RuntimeBenchmarkCell) => ({
    candidate: entry.candidate,
    runtime: entry.runtime,
    scenario: entry.scenario,
    repetition: entry.repetition,
    cacheState: entry.cacheState,
    order: ['base', 'candidate'] as const,
  });
  const resetEntry = (entry: RuntimeBenchmarkCell) => ({
    candidateId: entry.candidate,
    runtime: entry.runtime,
    scenario: entry.scenario,
    repetition: entry.repetition,
    cacheState: entry.cacheState,
    resetReceiptHash: createHash('sha256').update(`reset:${entry.candidate}:${entry.runtime}:${entry.scenario}:${entry.repetition}`).digest('hex'),
    verified: true,
  });
  return {
    schemaVersion: 1,
    role,
    executionProvenance: boundCells[0]?.executionProvenance ?? 'genuine_adapter',
    scope: boundCells[0]
      ? {
          runtime: boundCells[0].runtime,
          candidateId: boundCells[0].candidate,
          candidateConfigFingerprint: boundCells[0].candidateConfigFingerprint,
          outputRunNonce: 'a'.repeat(64),
          sampleKind: boundCells[0].executionProvenance === 'real_provider' ? 'real' : 'deterministic',
        }
      : null,
    lifecycle: {
      targetUrl: role === 'base' ? 'http://127.0.0.1:10000' : 'http://127.0.0.1:10001',
      serverIdentityHash: role === 'base' ? '4'.repeat(64) : '5'.repeat(64),
      targetConfigHash,
      sourceHash,
      outputRunNonce: 'a'.repeat(64),
      pairResetReceipts: boundCells.map(resetEntry),
      randomizedPairOrder: measured.map(pairEntry),
      warmupPairOrder: warmups.map(pairEntry),
      freshSessionsVerified: true,
      dataRoot: {
        idHash: role === 'base' ? 'b'.repeat(64) : 'c'.repeat(64),
        fresh: true,
        verified: true,
      },
      outputRoot: 'test-output/runtime-concurrency/test',
      cacheReset: {declared: true, receiptHash: 'd'.repeat(64)},
      ...overrides,
    },
    cells: boundCells,
  };
}

function scoreCandidateAdmission(input: {
  baseCells: RuntimeBenchmarkCell[];
  candidateCells: RuntimeBenchmarkCell[];
  candidate: BenchmarkCandidate;
  sampleKind: BenchmarkSampleKind;
  semanticGoldenAuthorizations?: Array<{
    authorizationId: string;
    candidateId: BenchmarkCandidate;
    runtime: RuntimeBenchmarkCell['runtime'];
    scenario: RuntimeBenchmarkCell['scenario'];
    sampleKind: BenchmarkSampleKind;
    baseFingerprint: string;
    candidateFingerprint: string;
  }>;
}) {
  const normalize = (entries: RuntimeBenchmarkCell[]) => entries.map(entry => ({
    ...entry,
    candidate: input.candidate,
    targetBinding: {
      ...entry.targetBinding,
      requestedCandidateId: input.candidate,
      observedCandidateId: input.candidate,
    },
    executionProvenance: input.sampleKind === 'real' ? 'real_provider' as const : entry.executionProvenance,
    ...(entry.performance && entry.firstOutputMs !== undefined
      ? {performance: {...entry.performance, firstOutputMs: entry.firstOutputMs}}
      : {}),
  }));
  let baseCells = normalize(input.baseCells);
  let candidateCells = normalize(input.candidateCells);
  if (input.sampleKind === 'real' && baseCells.filter(entry => !entry.warmup).length === 1) {
    baseCells = [1, 2, 3].map(repetition => ({...baseCells[0], repetition}));
    candidateCells = [1, 2, 3].map(repetition => ({...candidateCells[0], repetition}));
  }
  if (input.sampleKind === 'real' && !baseCells.some(entry => entry.warmup)) {
    baseCells = [{...baseCells[0], warmup: true, repetition: 0, cacheState: 'cold'}, ...baseCells];
    candidateCells = [{...candidateCells[0], warmup: true, repetition: 0, cacheState: 'cold'}, ...candidateCells];
  }
  return scoreCandidateAdmissionContract({
    baseArtifact: artifact('base', baseCells),
    candidateArtifact: artifact('candidate', candidateCells),
    candidate: input.candidate,
    runtime: baseCells[0].runtime,
    scenario: baseCells[0].scenario,
    sampleKind: input.sampleKind,
    semanticGoldenAuthorizations: input.semanticGoldenAuthorizations,
  });
}

function queryHash(value: string): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function syntheticArtifacts(
  candidate: BenchmarkCandidate = 'task6',
  runtime: RuntimeBenchmarkCell['runtime'] = 'openai-agents-sdk',
  scenario: RuntimeBenchmarkCell['scenario'] = 'startup-full',
): {base: RuntimeBenchmarkArtifactV1; candidate: RuntimeBenchmarkArtifactV1} {
  const matrix = buildSyntheticScorerMatrix({repetitions: 30});
  const baseCells = matrix
    .filter(entry => entry.role === 'base' && entry.cell.candidate === candidate && entry.cell.runtime === runtime && entry.cell.scenario === scenario)
    .map(entry => entry.cell);
  const candidateCells = matrix
    .filter(entry => entry.role === 'candidate' && entry.cell.candidate === candidate && entry.cell.runtime === runtime && entry.cell.scenario === scenario)
    .map(entry => entry.cell);
  return {
    base: artifact('base', baseCells),
    candidate: artifact('candidate', candidateCells),
  };
}

describe('agent runtime latency benchmark contracts', () => {
  it('canonicalizes semantic claim/root-cause identity while excluding prose and timestamps', () => {
    const initial = buildSemanticFingerprint({
      conclusionContract: conclusionContract(),
      identityResolutions: [{identityRefId: 'identity:app-main', status: 'verified'}],
      sourceClaimBindings: [],
    });
    const proseOnly = buildSemanticFingerprint({
      conclusionContract: conclusionContract({
        conclusions: [
          {rank: 1, statement: 'Different prose for the same root cause.'},
          {rank: 2, statement: 'Different secondary prose.'},
        ],
        claims: conclusionContract().claims?.map(claim => ({
          ...claim,
          text: `Reworded ${claim.id}`,
        })),
        metadata: {rounds: 99},
      }),
      identityResolutions: [{
        identityRefId: 'identity:app-main',
        status: 'verified',
        timestamp: 1_999_999_999,
      }],
      sourceClaimBindings: [],
    });
    const changedEvidence = buildSemanticFingerprint({
      conclusionContract: conclusionContract({
        claims: conclusionContract().claims?.map((claim, index) => index === 0
          ? {...claim, references: [{evidenceRefId: 'data:startup:different'}]}
          : claim),
      }),
      identityResolutions: [{identityRefId: 'identity:app-main', status: 'verified'}],
      sourceClaimBindings: [],
    });
    const changedOrder = buildSemanticFingerprint({
      conclusionContract: conclusionContract({
        conclusions: [
          {rank: 1, statement: 'Binder first'},
          {rank: 2, statement: 'Main thread second'},
        ],
        evidenceChain: [
          {conclusionId: 'root-binder', text: 'ignored'},
          {conclusionId: 'root-main-thread', text: 'ignored'},
        ],
      }),
      identityResolutions: [{identityRefId: 'identity:app-main', status: 'verified'}],
      sourceClaimBindings: [],
    });

    expect(proseOnly).toBe(initial);
    expect(changedEvidence).not.toBe(initial);
    expect(changedOrder).not.toBe(initial);
  });

  it('excludes per-upload trace UUIDs from semantic identity while retaining identity refs and status', () => {
    const first = buildSemanticFingerprint({
      conclusionContract: conclusionContract(),
      identityResolutions: [{
        identityRefId: 'identity:app-main',
        status: 'verified',
        target: {traceId: 'base-upload-uuid', traceSide: 'current', role: 'app_main', upid: 1},
      }],
      sourceClaimBindings: [],
    });
    const second = buildSemanticFingerprint({
      conclusionContract: conclusionContract(),
      identityResolutions: [{
        identityRefId: 'identity:app-main',
        status: 'verified',
        target: {traceId: 'candidate-upload-uuid', traceSide: 'current', role: 'app_main', upid: 1},
      }],
      sourceClaimBindings: [],
    });
    const changedStatus = buildSemanticFingerprint({
      conclusionContract: conclusionContract(),
      identityResolutions: [{
        identityRefId: 'identity:app-main',
        status: 'ambiguous',
        target: {traceId: 'candidate-upload-uuid', traceSide: 'current', role: 'app_main', upid: 1},
      }],
      sourceClaimBindings: [],
    });

    expect(second).toBe(first);
    expect(changedStatus).not.toBe(first);
  });

  it('parses typed cells/artifacts and rejects malformed timing or secret-bearing fields', () => {
    expect(parseRuntimeBenchmarkCell(cell())).toEqual(cell());
    expect(() => parseRuntimeBenchmarkCell({
      ...cell(),
      acceptedAtMs: 100,
      terminalMs: 99,
      firstOutputMs: undefined,
      performance: undefined,
    })).toThrow('benchmark_cell_terminal_before_accept');
    expect(() => parseRuntimeBenchmarkCell({...cell(), apiKey: 'secret'})).toThrow('benchmark_cell_unknown_field');
    expect(() => parseRuntimeBenchmarkCell({
      ...cell(),
      performance: {
        ...basePerformance,
        tools: [{prompt: 'must-not-persist'}],
      },
    })).toThrow('benchmark_runtime_tool_unknown_field');

    const parsedArtifact = parseRuntimeBenchmarkArtifact(artifact('base', [cell()]));
    expect(parsedArtifact.cells).toHaveLength(1);
    expect(() => parseRuntimeBenchmarkArtifact({...parsedArtifact, role: 'other'})).toThrow('benchmark_artifact_role_invalid');
    expect(() => parseRuntimeBenchmarkArtifact({
      ...parsedArtifact,
      executionProvenance: 'synthetic_scorer',
    })).toThrow('benchmark_artifact_provenance_mismatch');
  });

  it('rejects provider/model/snapshot/runtime/trace/query/mode mismatches before scoring', () => {
    const base = cell();
    const mismatches: Array<Partial<RuntimeBenchmarkCell>> = [
      {runtime: 'pi-agent-core'},
      {providerId: 'other-provider'},
      {model: 'other-model'},
      {providerSnapshotHash: 'sha256:ffffffffffffffffffffffffffffffff'},
      {trace: 'other-trace'},
      {queryHash: 'b'.repeat(64)},
      {mode: 'fast'},
      {cacheState: 'cold'},
    ];
    for (const mismatch of mismatches) {
      expect(() => assertPairedBenchmarkCells(base, cell(mismatch))).toThrow('benchmark_pair_identity_mismatch');
    }
  });

  it('marks missing model/snapshot/usage/first-output/performance metrics inconclusive instead of passed', () => {
    const base = cell();
    const candidate = cell({
      model: undefined,
      providerSnapshotHash: undefined,
      providerUsage: undefined,
      firstOutputMs: undefined,
      performance: undefined,
      terminalMs: 3_000,
    });
    const result = scoreCandidateAdmission({
      baseCells: [{...base, model: undefined, providerSnapshotHash: undefined}],
      candidateCells: [candidate],
      candidate: 'task6',
      sampleKind: 'real',
    });

    expect(result.decision).toBe('serial');
    expect(result.observability.status).toBe('INCONCLUSIVE');
    expect(result.performance.status).toBe('INCONCLUSIVE');
    expect(result.reasons).toEqual(expect.arrayContaining([
      'model_missing',
      'provider_snapshot_hash_missing',
      'provider_usage_missing',
      'first_output_missing',
      'runtime_performance_missing',
    ]));
  });

  it('keeps truncated or non-successful runtime performance receipts inconclusive', () => {
    const base = cell();
    const candidate = cell({
      terminalMs: 3_400,
      performance: {
        ...candidatePerformance,
        phases: candidatePerformance.phases.map((phase, index) => index === 0
          ? {...phase, outcome: 'error'}
          : phase),
        truncated: {phases: 1, tools: 0, sql: 0},
      },
    });
    const result = scoreCandidateAdmission({
      baseCells: [base, {...base, repetition: 2}, {...base, repetition: 3}],
      candidateCells: [candidate, {...candidate, repetition: 2}, {...candidate, repetition: 3}],
      candidate: 'task6',
      sampleKind: 'real',
    });

    expect(result.observability.status).toBe('INCONCLUSIVE');
    expect(result.reasons).toEqual(expect.arrayContaining([
      'runtime_performance_truncated',
      'runtime_performance_non_ok',
    ]));
    expect(result.decision).toBe('serial');
  });

  it('admits a deterministic candidate at the 15% total or 30% mapped-phase threshold with no material regression', () => {
    const baseCells = Array.from({length: 30}, (_, index) => cell({repetition: index + 1}));
    const candidateCells = Array.from({length: 30}, (_, index) => cell({
      repetition: index + 1,
      firstOutputMs: 850,
      terminalMs: 3_400,
      performance: candidatePerformance,
    }));

    const result = scoreCandidateAdmission({
      baseCells,
      candidateCells,
      candidate: 'task6',
      sampleKind: 'deterministic',
    });

    expect(result.decision).toBe('default_on');
    expect(result.quality.status).toBe('PASS');
    expect(result.performance.status).toBe('PASS');
    expect(result.totalP95.status).toBe('PASS');
    expect(result.firstOutputP95.status).toBe('PASS');
    expect(result.targetPhases).toEqual(CANDIDATE_TARGET_PHASES.task6);
  });

  it('treats total >=15% and mapped phase >=30% as independent admission paths', () => {
    const baseCells = Array.from({length: 30}, (_, index) => cell({repetition: index + 1}));
    const totalOnlyPerformance: RuntimePerformanceReceiptV1 = {
      ...candidatePerformance,
      phases: [{name: 'architecture', startOffsetMs: 0, durationMs: 50, outcome: 'ok'}],
    };
    const totalOnly = Array.from({length: 30}, (_, index) => cell({
      repetition: index + 1,
      firstOutputMs: 850,
      terminalMs: 3_400,
      performance: totalOnlyPerformance,
    }));
    const phaseOnly = Array.from({length: 30}, (_, index) => cell({
      repetition: index + 1,
      firstOutputMs: 850,
      terminalMs: 3_700,
      performance: candidatePerformance,
    }));

    expect(scoreCandidateAdmission({
      baseCells,
      candidateCells: totalOnly,
      candidate: 'task6',
      sampleKind: 'deterministic',
    }).performance.status).toBe('PASS');
    expect(scoreCandidateAdmission({
      baseCells,
      candidateCells: phaseOnly,
      candidate: 'task6',
      sampleKind: 'deterministic',
    }).performance.status).toBe('PASS');
  });

  it('gates Task 5 on total latency only across every runtime', () => {
    for (const runtime of PRODUCTION_RUNTIME_KINDS) {
      const baseCells = Array.from({length: 30}, (_, index) => cell({
        repetition: index + 1,
        runtime,
      }));
      const totalPass = Array.from({length: 30}, (_, index) => cell({
        repetition: index + 1,
        runtime,
        firstOutputMs: 850,
        terminalMs: 3_400,
        performance: candidatePerformance,
      }));
      const totalMiss = totalPass.map(entry => ({...entry, terminalMs: 3_500}));

      const passed = scoreCandidateAdmission({
        baseCells,
        candidateCells: totalPass,
        candidate: 'task5',
        sampleKind: 'deterministic',
      });
      expect(passed.targetPhases).toEqual([]);
      expect(passed.performance.status).toBe('PASS');
      expect(passed.decision).toBe('default_on');

      const missed = scoreCandidateAdmission({
        baseCells,
        candidateCells: totalMiss,
        candidate: 'task5',
        sampleKind: 'deterministic',
      });
      expect(missed.performance.status).toBe('FAIL');
      expect(missed.reasons).toContain('performance_threshold_not_met');
      expect(missed.decision).toBe('serial');
    }
  });

  it('requires both >5% and >250ms before first-output/p95 regression is material', () => {
    const baseCells = Array.from({length: 30}, (_, index) => cell({repetition: index + 1}));
    const withinAbsoluteBound = Array.from({length: 30}, (_, index) => cell({
      repetition: index + 1,
      firstOutputMs: 1_240,
      terminalMs: 3_400,
      performance: candidatePerformance,
    }));
    const material = withinAbsoluteBound.map((entry, index) => index >= 28
      ? {
        ...entry,
        firstOutputMs: 1_400,
        terminalMs: 5_000,
      }
      : entry);

    expect(scoreCandidateAdmission({
      baseCells,
      candidateCells: withinAbsoluteBound,
      candidate: 'task6',
      sampleKind: 'deterministic',
    }).firstOutputP95.status).toBe('PASS');
    const failed = scoreCandidateAdmission({
      baseCells,
      candidateCells: material,
      candidate: 'task6',
      sampleKind: 'deterministic',
    });
    expect(failed.firstOutputP95.status).toBe('FAIL');
    expect(failed.totalP95.status).toBe('FAIL');
    expect(failed.decision).toBe('serial');
  });

  it('rejects provider pin drift between repetitions even when each pair matches', () => {
    const baseCells = [1, 2, 3].map(repetition => cell({
      repetition,
      ...(repetition === 2 ? {providerId: 'drifted-provider'} : {}),
    }));
    const candidateCells = baseCells.map(entry => ({
      ...entry,
      terminalMs: 3_400,
      performance: candidatePerformance,
    }));

    expect(() => scoreCandidateAdmission({
      baseCells,
      candidateCells,
      candidate: 'task6',
      sampleKind: 'real',
    })).toThrow('benchmark_sample_identity_drift');
  });

  it('gates real samples by paired median and observed max while reporting p95 inconclusive', () => {
    const baseCells = [1, 2, 3].map(repetition => cell({repetition}));
    const candidateCells = [1, 2, 3].map(repetition => cell({
      repetition,
      firstOutputMs: 850,
      terminalMs: 3_400,
      performance: candidatePerformance,
    }));

    const result = scoreCandidateAdmission({
      baseCells,
      candidateCells,
      candidate: 'task6',
      sampleKind: 'real',
    });

    expect(result.performance.status).toBe('PASS');
    expect(result.observedMax.status).toBe('PASS');
    expect(result.totalP95.status).toBe('INCONCLUSIVE');
    expect(result.firstOutputP95.status).toBe('INCONCLUSIVE');
    expect(result.decision).toBe('default_on');
    expect(result).toMatchObject({
      candidateId: 'task6', runtime: 'openai-agents-sdk', scenario: 'startup-full', sampleKind: 'real',
    });
  });

  it('aggregates a candidate only when every required runtime/scenario group is default-on', () => {
    const group = scoreCandidateAdmission({
      baseCells: [1, 2, 3].map(repetition => cell({repetition})),
      candidateCells: [1, 2, 3].map(repetition => cell({repetition, firstOutputMs: 850, terminalMs: 3_400})),
      candidate: 'task6',
      sampleKind: 'real',
    });
    const openAiGroups = [
      group,
      {...group, scenario: 'scrolling-full' as const},
      {...group, scenario: 'identity-fast' as const},
    ];
    const groups = [
      ...openAiGroups,
      ...openAiGroups.map(entry => ({
        ...entry,
        runtime: 'claude-agent-sdk' as const,
        scope: {...entry.scope, runtime: 'claude-agent-sdk' as const},
      })),
    ];
    expect(aggregateCandidateAdmissions(openAiGroups, 'task6', 'real')).toMatchObject({
      decision: 'serial',
      reasons: expect.arrayContaining(['missing_required_group:claude-agent-sdk|startup-full']),
    });
    expect(aggregateCandidateAdmissions(groups, 'task6', 'real').decision).toBe('default_on');
    const degraded = groups.map((entry, index) => index === 1
      ? {...entry, decision: 'serial' as const, reasons: ['observability_missing']}
      : entry);
    const aggregate = aggregateCandidateAdmissions(degraded, 'task6', 'real');
    expect(aggregate.decision).toBe('serial');
    expect(aggregate.reasons[0]).toContain('scrolling-full');
    expect(() => aggregateCandidateAdmissions(groups.map((entry, index) => index === 5
      ? {
          ...entry,
          candidateConfigFingerprint: 'c'.repeat(64),
          scope: {...entry.scope, candidateConfigFingerprint: 'c'.repeat(64)},
        }
      : entry), 'task6', 'real')).toThrow('benchmark_candidate_aggregate_mixed_config_fingerprints');
    expect(() => aggregateCandidateAdmissions(groups.map((entry, index) => index === 5
      ? {...entry, runtime: 'openai-agents-sdk'}
      : entry), 'task6', 'real')).toThrow('benchmark_candidate_result_scope_mismatch');
  });

  it('fails every quality regression unless an exact semantic golden authorization is supplied', () => {
    const base = cell();
    const regressions: Array<Partial<RuntimeBenchmarkCell['quality']>> = [
      {semanticFingerprint: `sha256:${'e'.repeat(64)}`},
      {unsupportedClaims: 1},
      {verifiedClaims: 1},
      {identityErrors: 1},
      {finalReportGate: 'partial'},
      {claimVerificationGate: 'partial'},
      {identityResolutionGate: 'partial'},
      {evidenceBindingHashes: []},
      {identityBindingHashes: []},
      {sourceBindingHashes: [`sha256:${'f'.repeat(64)}`]},
    ];
    for (const regression of regressions) {
      const candidate = cell({quality: {...base.quality, ...regression}, terminalMs: 3_400, performance: candidatePerformance});
      expect(scoreCandidateAdmission({
        baseCells: [base, {...base, repetition: 2}, {...base, repetition: 3}],
        candidateCells: [candidate, {...candidate, repetition: 2}, {...candidate, repetition: 3}],
        candidate: 'task6',
        sampleKind: 'real',
      }).quality.status).toBe('FAIL');
    }

    const changed = cell({
      quality: {...base.quality, semanticFingerprint: `sha256:${'1'.repeat(64)}`},
      terminalMs: 3_400,
      performance: candidatePerformance,
    });
    const authorized = scoreCandidateAdmission({
      baseCells: [base, {...base, repetition: 2}, {...base, repetition: 3}],
      candidateCells: [changed, {...changed, repetition: 2}, {...changed, repetition: 3}],
      candidate: 'task6',
      sampleKind: 'real',
      semanticGoldenAuthorizations: [{
        authorizationId: 'golden:startup-full:v1',
        candidateId: 'task6',
        runtime: 'openai-agents-sdk',
        scenario: 'startup-full',
        sampleKind: 'real',
        baseFingerprint: base.quality.semanticFingerprint,
        candidateFingerprint: changed.quality.semanticFingerprint,
      }],
    });
    expect(authorized.quality.status).toBe('PASS');
    const wrongScope = scoreCandidateAdmission({
      baseCells: [base, {...base, repetition: 2}, {...base, repetition: 3}],
      candidateCells: [changed, {...changed, repetition: 2}, {...changed, repetition: 3}],
      candidate: 'task6',
      sampleKind: 'real',
      semanticGoldenAuthorizations: [{
        authorizationId: 'golden:wrong-runtime:v1',
        candidateId: 'task6',
        runtime: 'claude-agent-sdk',
        scenario: 'startup-full',
        sampleKind: 'real',
        baseFingerprint: base.quality.semanticFingerprint,
        candidateFingerprint: changed.quality.semanticFingerprint,
      }],
    });
    expect(wrongScope.quality.status).toBe('FAIL');
  });

  it('rejects duplicate, missing, and noncontiguous deterministic repetitions plus pair-order drift', () => {
    const valid = syntheticArtifacts();
    const duplicate = structuredClone(valid.base);
    duplicate.cells.push(structuredClone(duplicate.cells[0]));
    duplicate.lifecycle.randomizedPairOrder.push(structuredClone(duplicate.lifecycle.randomizedPairOrder[0]));
    expect(() => scoreCandidateAdmissionContract({
      baseArtifact: duplicate,
      candidateArtifact: valid.candidate,
      candidate: 'task6',
      runtime: 'openai-agents-sdk',
      scenario: 'startup-full',
      sampleKind: 'deterministic',
    })).toThrow('benchmark_duplicate_measured_cell');

    const gapBase = structuredClone(valid.base);
    const gapCandidate = structuredClone(valid.candidate);
    gapBase.cells = gapBase.cells.filter(entry => entry.repetition !== 15);
    gapCandidate.cells = gapCandidate.cells.filter(entry => entry.repetition !== 15);
    gapBase.lifecycle.randomizedPairOrder = gapBase.lifecycle.randomizedPairOrder.filter(entry => entry.repetition !== 15);
    gapCandidate.lifecycle.randomizedPairOrder = gapCandidate.lifecycle.randomizedPairOrder.filter(entry => entry.repetition !== 15);
    gapBase.lifecycle.pairResetReceipts = gapBase.lifecycle.pairResetReceipts.filter(entry => entry.repetition !== 15);
    gapCandidate.lifecycle.pairResetReceipts = gapCandidate.lifecycle.pairResetReceipts.filter(entry => entry.repetition !== 15);
    expect(() => scoreCandidateAdmissionContract({
      baseArtifact: gapBase,
      candidateArtifact: gapCandidate,
      candidate: 'task6',
      runtime: 'openai-agents-sdk',
      scenario: 'startup-full',
      sampleKind: 'deterministic',
    })).toThrow('benchmark_deterministic_repetitions_must_be_exact_1_to_30');

    const missingOrder = structuredClone(valid.base);
    missingOrder.lifecycle.randomizedPairOrder.pop();
    expect(() => scoreCandidateAdmissionContract({
      baseArtifact: missingOrder,
      candidateArtifact: valid.candidate,
      candidate: 'task6',
      runtime: 'openai-agents-sdk',
      scenario: 'startup-full',
      sampleKind: 'deterministic',
    })).toThrow('benchmark_pair_order_coverage_mismatch');
  });

  it('rejects mixed artifact scope before group filtering or scoring', () => {
    const valid = syntheticArtifacts();
    const mutations: Array<{
      mutate(artifact: RuntimeBenchmarkArtifactV1): void;
      error: string;
    }> = [
      {
        mutate: artifact => { artifact.scope!.candidateId = 'task4'; },
        error: 'benchmark_artifact_scope_cell_mismatch',
      },
      {
        mutate: artifact => { artifact.scope!.candidateConfigFingerprint = 'e'.repeat(64); },
        error: 'benchmark_artifact_scope_cell_mismatch',
      },
      {
        mutate: artifact => { artifact.scope!.runtime = 'claude-agent-sdk'; },
        error: 'benchmark_artifact_scope_cell_mismatch',
      },
      {
        mutate: artifact => { artifact.scope!.outputRunNonce = 'e'.repeat(64); },
        error: 'benchmark_artifact_scope_output_nonce_mismatch',
      },
      {
        mutate: artifact => { artifact.scope!.sampleKind = 'real'; },
        error: 'benchmark_artifact_scope_provenance_mismatch',
      },
      {
        mutate: artifact => { artifact.lifecycle.randomizedPairOrder[0].runtime = 'claude-agent-sdk'; },
        error: 'benchmark_artifact_scope_pair_order_mismatch',
      },
      {
        mutate: artifact => { artifact.lifecycle.pairResetReceipts[0].runtime = 'claude-agent-sdk'; },
        error: 'benchmark_artifact_scope_pair_reset_mismatch',
      },
    ];
    for (const {mutate, error} of mutations) {
      const mixed = structuredClone(valid.base);
      mutate(mixed);
      expect(() => parseRuntimeBenchmarkArtifact(mixed)).toThrow(error);
    }

    expect(() => scoreCandidateAdmissionContract({
      baseArtifact: valid.base,
      candidateArtifact: valid.candidate,
      candidate: 'task6',
      runtime: 'claude-agent-sdk',
      scenario: 'startup-full',
      sampleKind: 'deterministic',
    })).toThrow('benchmark_artifact_scope_request_mismatch');
  });

  it('requires exact real repetitions 1..3 and one cold warm-up per role', () => {
    const baseCells = [1, 2, 3].map(repetition => cell({repetition, executionProvenance: 'real_provider'}));
    const candidateCells = [1, 2, 3].map(repetition => cell({
      repetition, terminalMs: 3_400, executionProvenance: 'real_provider',
    }));
    expect(() => scoreCandidateAdmissionContract({
      baseArtifact: artifact('base', baseCells),
      candidateArtifact: artifact('candidate', candidateCells),
      candidate: 'task6',
      runtime: 'openai-agents-sdk',
      scenario: 'startup-full',
      sampleKind: 'real',
    })).toThrow('benchmark_real_warmup_required');
  });

  it('binds warm-up cleanup failure to real admission instead of filtering it out', () => {
    const baseWarmup = cell({
      warmup: true, repetition: 0, cacheState: 'cold', executionProvenance: 'real_provider',
    });
    const candidateWarmup = cell({
      warmup: true,
      repetition: 0,
      cacheState: 'cold',
      executionProvenance: 'real_provider',
      cleanup: {...cell().cleanup, session: {attempted: true, success: false, status: 500, error: 'cleanup_failed'}},
    });
    const baseCells = [baseWarmup, ...[1, 2, 3].map(repetition => cell({
      repetition, executionProvenance: 'real_provider',
    }))];
    const candidateCells = [candidateWarmup, ...[1, 2, 3].map(repetition => cell({
      repetition, terminalMs: 3_400, executionProvenance: 'real_provider',
    }))];
    const result = scoreCandidateAdmissionContract({
      baseArtifact: artifact('base', baseCells),
      candidateArtifact: artifact('candidate', candidateCells),
      candidate: 'task6',
      runtime: 'openai-agents-sdk',
      scenario: 'startup-full',
      sampleKind: 'real',
    });
    expect(result.decision).toBe('serial');
    expect(result.reasons).toContain('session_cleanup_failed');
  });

  it('binds lifecycle freshness, distinct data roots, cache reset, and cleanup to serial admission', () => {
    const valid = syntheticArtifacts();
    const unverifiedBase = structuredClone(valid.base);
    const unverifiedCandidate = structuredClone(valid.candidate);
    unverifiedBase.lifecycle.freshSessionsVerified = false;
    unverifiedBase.lifecycle.dataRoot = {idHash: '9'.repeat(64), fresh: false, verified: false};
    unverifiedCandidate.lifecycle.dataRoot = {idHash: '9'.repeat(64), fresh: false, verified: false};
    unverifiedCandidate.lifecycle.cacheReset = {declared: false, reason: 'unverified'};
    const unverifiedResets = unverifiedCandidate.lifecycle.pairResetReceipts.map(entry => ({
      ...entry,
      verified: false,
    }));
    unverifiedBase.lifecycle.pairResetReceipts = structuredClone(unverifiedResets);
    unverifiedCandidate.lifecycle.pairResetReceipts = unverifiedResets;
    unverifiedCandidate.cells = unverifiedCandidate.cells.map(entry => ({
      ...entry,
      cleanup: {...entry.cleanup, trace: {attempted: true, success: false, status: 500, error: 'cleanup_failed'}},
    }));
    const result = scoreCandidateAdmissionContract({
      baseArtifact: unverifiedBase,
      candidateArtifact: unverifiedCandidate,
      candidate: 'task6',
      runtime: 'openai-agents-sdk',
      scenario: 'startup-full',
      sampleKind: 'deterministic',
    });
    expect(result.decision).toBe('serial');
    expect(result.observability.status).toBe('INCONCLUSIVE');
    expect(result.reasons).toEqual(expect.arrayContaining([
      'fresh_sessions_unverified',
      'fresh_data_root_unverified',
      'data_root_identity_unverified',
      'data_roots_not_distinct',
      'cache_reset_not_declared',
      'cache_reset_receipt_missing',
      'pair_reset_receipt_unverified',
      'trace_cleanup_failed',
    ]));
  });

  it('never admits partial, quota, cancelled, or error terminal outcomes', () => {
    for (const terminalOutcome of ['partial', 'quota_exceeded', 'cancelled', 'error'] as const) {
      const artifacts = syntheticArtifacts();
      artifacts.candidate.cells = artifacts.candidate.cells.map((entry, index) => index === 0
        ? {...entry, terminalOutcome}
        : entry);
      const result = scoreCandidateAdmissionContract({
        baseArtifact: artifacts.base,
        candidateArtifact: artifacts.candidate,
        candidate: 'task6', runtime: 'openai-agents-sdk', scenario: 'startup-full', sampleKind: 'deterministic',
      });
      expect(result.decision).toBe('serial');
      expect(result.reasons).toContain('non_completed_cell_present');
    }
  });

  it('rejects target receipt correlation mismatches and leaves missing observed query identity inconclusive', () => {
    expect(() => parseRuntimeBenchmarkCell({
      ...cell(),
      targetBinding: {...cell().targetBinding, receiptTraceId: 'different-trace'},
    })).toThrow('benchmark_target_binding_mismatch');

    const artifacts = syntheticArtifacts();
    artifacts.base.cells = artifacts.base.cells.map(entry => ({
      ...entry,
      targetBinding: {...entry.targetBinding, observedQueryHash: undefined},
    }));
    artifacts.candidate.cells = artifacts.candidate.cells.map(entry => ({
      ...entry,
      targetBinding: {...entry.targetBinding, observedQueryHash: undefined},
    }));
    const result = scoreCandidateAdmissionContract({
      baseArtifact: artifacts.base,
      candidateArtifact: artifacts.candidate,
      candidate: 'task6',
      runtime: 'openai-agents-sdk',
      scenario: 'startup-full',
      sampleKind: 'deterministic',
    });
    expect(result.observability.status).toBe('INCONCLUSIVE');
    expect(result.reasons).toContain('observed_query_hash_missing');
  });

  it('requires target-observed candidate id/config and binds target config/source hashes to each artifact role', () => {
    expect(() => parseRuntimeBenchmarkCell({
      ...cell(),
      targetBinding: {...cell().targetBinding, observedCandidateId: 'task4'},
    })).toThrow('benchmark_observed_candidate_id_mismatch');
    expect(() => parseRuntimeBenchmarkCell({
      ...cell(),
      targetBinding: {...cell().targetBinding, observedCandidateConfigFingerprint: 'c'.repeat(64)},
    })).toThrow('benchmark_observed_candidate_config_fingerprint_mismatch');

    const artifacts = syntheticArtifacts();
    artifacts.candidate.cells = artifacts.candidate.cells.map(entry => ({
      ...entry,
      targetBinding: {...entry.targetBinding, observedCandidateId: undefined},
    }));
    artifacts.base.cells = artifacts.base.cells.map(entry => ({
      ...entry,
      targetBinding: {...entry.targetBinding, observedSourceHash: 'f'.repeat(64)},
    }));
    const result = scoreCandidateAdmissionContract({
      baseArtifact: artifacts.base,
      candidateArtifact: artifacts.candidate,
      candidate: 'task6', runtime: 'openai-agents-sdk', scenario: 'startup-full', sampleKind: 'deterministic',
    });
    expect(result.decision).toBe('serial');
    expect(result.reasons).toEqual(expect.arrayContaining([
      'observed_candidate_id_missing',
      'base_source_hash_mismatch',
    ]));
  });

  it('fingerprints claim artifact refs and official resolved identity process/thread/warning state', () => {
    const baseContract = conclusionContract({
      claims: conclusionContract().claims?.map((claim, index) => index === 0
        ? {...claim, artifactRefs: [{artifactId: 'artifact:one', rowIndex: 0}]}
        : claim),
    });
    const identity = [{
      identityRefId: 'identity:app-main',
      status: 'verified',
      target: {traceId: 'upload-a', role: 'app_main'},
      processes: [{upid: 1, pid: 100, processName: 'app', matchSources: ['sql'], confidence: 1}],
      threads: [{utid: 2, tid: 101, threadName: 'main', owningUpid: 1, matchSources: ['sql'], confidence: 1}],
      warnings: [],
    }];
    const base = buildSemanticFingerprint({conclusionContract: baseContract, identityResolutions: identity, sourceClaimBindings: []});
    const artifactChanged = buildSemanticFingerprint({
      conclusionContract: {
        ...baseContract,
        claims: baseContract.claims?.map((claim, index) => index === 0
          ? {...claim, artifactRefs: [{artifactId: 'artifact:two', rowIndex: 0}]}
          : claim),
      },
      identityResolutions: identity,
      sourceClaimBindings: [],
    });
    const identityChanged = buildSemanticFingerprint({
      conclusionContract: baseContract,
      identityResolutions: [{...identity[0], warnings: ['ambiguous_process']}],
      sourceClaimBindings: [],
    });
    const artifactOnly = buildSemanticFingerprint({
      conclusionContract: conclusionContract({
        claims: conclusionContract().claims?.map((claim, index) => index === 0
          ? {...claim, references: [], artifactRefs: [{artifactId: 'artifact:only', rowIndex: 0}]}
          : claim),
      }),
      identityResolutions: identity,
      sourceClaimBindings: [],
    });
    expect(artifactChanged).not.toBe(base);
    expect(identityChanged).not.toBe(base);
    expect(artifactOnly).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('rejects unknown gates, invalid timing bounds, and inconsistent first-output receipts', () => {
    expect(() => parseRuntimeBenchmarkCell({...cell(), quality: {...cell().quality, finalReportGate: 'unknown'}})).toThrow('benchmark_final_report_gate_invalid');
    expect(() => parseRuntimeBenchmarkCell({...cell(), terminalMs: 0})).toThrow('benchmark_cell_terminal_invalid');
    expect(() => parseRuntimeBenchmarkCell({...cell(), firstOutputMs: 4_001})).toThrow('benchmark_cell_first_output_after_terminal');
    expect(() => parseRuntimeBenchmarkCell({
      ...cell(),
      firstOutputMs: 900,
      performance: {...basePerformance, firstOutputMs: 1_000},
    })).toThrow('benchmark_first_output_receipt_mismatch');
    expect(() => parseRuntimeBenchmarkCell({
      ...cell(),
      performance: {
        ...basePerformance,
        phases: [{name: 'provider', startOffsetMs: 0, durationMs: 4_001, outcome: 'ok'}],
      },
    })).toThrow('benchmark_runtime_phase_after_terminal');
    expect(() => parseRuntimeBenchmarkCell({
      ...cell(),
      performance: {
        ...basePerformance,
        tools: [{
          toolCallIdHash: `sha256:${'2'.repeat(32)}`,
          mode: 'exclusive', schedulerWaitMs: 0, durationMs: 7 * 24 * 60 * 60 * 1_000 + 1, outcome: 'ok',
        }],
      },
    })).toThrow('benchmark_runtime_tool_duration_invalid');
    expect(() => parseRuntimeBenchmarkCell({
      ...cell(),
      performance: {
        ...basePerformance,
        sql: [{
          processorKeyHash: `sha256:${'3'.repeat(32)}`,
          priority: 'p1', queueWaitMs: 0, executionMs: 7 * 24 * 60 * 60 * 1_000 + 1, outcome: 'ok',
        }],
      },
    })).toThrow('benchmark_runtime_sql_execution_invalid');
    expect(() => parseRuntimeBenchmarkCell({...cell(), providerSnapshotHash: 'sk-secret-value'})).toThrow('benchmark_cell_provider_snapshot_hash_invalid');
    expect(() => parseRuntimeBenchmarkCell({...cell(), model: 'safe-model\nBearer secret'})).toThrow('benchmark_cell_model_invalid');
    expect(() => parseRuntimeBenchmarkCell({...cell(), model: 'sk-secret-model'})).toThrow('benchmark_cell_model_invalid');
  });

  it('keeps zero first-output baselines inconclusive instead of producing an infinite ratio', () => {
    const artifacts = syntheticArtifacts();
    artifacts.base.cells = artifacts.base.cells.map(entry => ({
      ...entry,
      firstOutputMs: 0,
      performance: {...entry.performance!, firstOutputMs: 0},
    }));
    const result = scoreCandidateAdmissionContract({
      baseArtifact: artifacts.base,
      candidateArtifact: artifacts.candidate,
      candidate: 'task6',
      runtime: 'openai-agents-sdk',
      scenario: 'startup-full',
      sampleKind: 'deterministic',
    });
    expect(result.firstOutputMedian.status).toBe('INCONCLUSIVE');
    expect(result.firstOutputP95.status).toBe('INCONCLUSIVE');
    expect(result.decision).toBe('serial');
  });

  it('exercises scorer mechanics with 30 synthetic repetitions for every Task 4-9 runtime mapping without claiming runtime admission', () => {
    const matrix = buildSyntheticScorerMatrix({repetitions: 30});
    const mappings: Array<[BenchmarkCandidate, readonly RuntimeBenchmarkCell['runtime'][]]> = [
      ['task4', PRODUCTION_RUNTIME_KINDS],
      ['task5', PRODUCTION_RUNTIME_KINDS],
      ['task6', ['claude-agent-sdk', 'openai-agents-sdk']],
      ['task7', ['pi-agent-core']],
      ['task8', ['opencode']],
      ['task9', ['qoder-agent-sdk']],
    ];
    expect(matrix).toHaveLength(15 * 3 * 30 * 2);

    for (const [candidate, runtimes] of mappings) {
      for (const runtime of runtimes) {
        for (const scenario of ['startup-full', 'scrolling-full', 'identity-fast'] as const) {
          const baseCells = matrix.filter(entry => entry.role === 'base' && entry.cell.candidate === candidate && entry.cell.runtime === runtime && entry.cell.scenario === scenario).map(entry => entry.cell);
          const candidateCells = matrix.filter(entry => entry.role === 'candidate' && entry.cell.candidate === candidate && entry.cell.runtime === runtime && entry.cell.scenario === scenario).map(entry => entry.cell);
          expect(baseCells).toHaveLength(30);
          expect(candidateCells).toHaveLength(30);
          const scored = scoreCandidateAdmission({
            baseCells,
            candidateCells,
            candidate,
            sampleKind: 'deterministic',
          });
          expect(scored.quality.status).toBe('PASS');
          expect(scored.observability.status).toBe('INCONCLUSIVE');
          expect(scored.decision).toBe('serial');
          expect(scored.reasons).toContain('deterministic_genuine_adapter_required');
        }
      }
    }
  });
});

describe('agent runtime latency target runner safety', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await fsp.rm(dir, {recursive: true, force: true});
    }
  });

  async function tempBackendRoot(): Promise<string> {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-latency-'));
    tempDirs.push(root);
    await fsp.mkdir(path.join(root, 'test-output', 'runtime-concurrency'), {recursive: true});
    return root;
  }

  it('accepts only exact loopback target URLs and a fresh output directory under the ignored root', async () => {
    const backendRoot = await tempBackendRoot();
    const options = parseAgentLatencyArgs([
      '--base-url', 'http://127.0.0.1:10000',
      '--candidate-url', 'http://[::1]:10001',
      '--runtime', 'openai-agents-sdk',
      '--output-dir', 'test-output/runtime-concurrency/run-1',
    ], {backendRoot});
    expect(options.outputDir).toBe(path.join(backendRoot, 'test-output', 'runtime-concurrency', 'run-1'));
    expect(() => parseAgentLatencyArgs([
      '--base-url', 'https://example.com',
      '--candidate-url', 'http://[::1]:10001',
      '--runtime', 'openai-agents-sdk',
      '--output-dir', 'test-output/runtime-concurrency/run-2',
    ], {backendRoot})).toThrow('benchmark_target_url_protocol_invalid');
    expect(() => parseAgentLatencyArgs([
      '--base-url', 'http://localhost:10000',
      '--candidate-url', 'http://[::1]:10001',
      '--runtime', 'openai-agents-sdk',
      '--output-dir', 'test-output/runtime-concurrency/run-2',
    ], {backendRoot})).toThrow('benchmark_target_url_not_loopback');
    expect(() => parseAgentLatencyArgs([
      '--base-url', 'http://user:secret@127.0.0.1:10000',
      '--candidate-url', 'http://[::1]:10001',
      '--runtime', 'openai-agents-sdk',
      '--output-dir', 'test-output/runtime-concurrency/run-2',
    ], {backendRoot})).toThrow('benchmark_target_url_credentials_forbidden');
    expect(() => parseAgentLatencyArgs([
      '--base-url', 'http://127.0.0.1:10000',
      '--candidate-url', 'http://[::1]:10001',
      '--runtime', 'openai-agents-sdk',
      '--output-dir', '../escape',
    ], {backendRoot})).toThrow('benchmark_output_dir_outside_root');

    await fsp.mkdir(path.join(backendRoot, 'test-output', 'runtime-concurrency', 'existing'));
    expect(() => parseAgentLatencyArgs([
      '--base-url', 'http://127.0.0.1:10000',
      '--candidate-url', 'http://[::1]:10001',
      '--runtime', 'openai-agents-sdk',
      '--output-dir', 'test-output/runtime-concurrency/existing',
    ], {backendRoot})).toThrow('benchmark_output_dir_not_fresh');

    const external = await fsp.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-latency-external-'));
    tempDirs.push(external);
    await fsp.symlink(external, path.join(backendRoot, 'test-output', 'runtime-concurrency', 'link'));
    expect(() => parseAgentLatencyArgs([
      '--base-url', 'http://127.0.0.1:10000',
      '--candidate-url', 'http://[::1]:10001',
      '--runtime', 'openai-agents-sdk',
      '--output-dir', 'test-output/runtime-concurrency/link/run',
    ], {backendRoot})).toThrow('benchmark_output_dir_symlink_forbidden');
  });

  it('accepts a fresh structured lifecycle receipt and binds exact targets, identities, roots, protocol, and pair count', async () => {
    const backendRoot = await tempBackendRoot();
    const nowMs = 2_000_000;
    const outputRunNonce = '9'.repeat(64);
    const pairResetReceipts = (['startup-full', 'scrolling-full', 'identity-fast'] as const).flatMap(scenario =>
      Array.from({length: 4}, (_, repetition) => ({
        candidateId: 'task6' as const,
        runtime: 'openai-agents-sdk' as const,
        scenario,
        repetition,
        cacheState: repetition === 0 ? 'cold' as const : 'warm' as const,
        resetReceiptHash: createHash('sha256').update(`${scenario}:${repetition}`).digest('hex'),
        verified: true,
      })));
    const receipt = {
      schemaVersion: 1,
      generatedAtMs: nowMs,
      baseUrl: 'http://127.0.0.1:10000',
      candidateUrl: 'http://127.0.0.1:10001',
      runtime: 'openai-agents-sdk',
      candidateId: 'task6',
      candidateConfigFingerprint: CANDIDATE_CONFIG_FINGERPRINT,
      outputRunNonce,
      baseServerIdentityHash: '1'.repeat(64),
      candidateServerIdentityHash: '2'.repeat(64),
      baseConfigHash: '3'.repeat(64),
      candidateConfigHash: '4'.repeat(64),
      baseSourceHash: '5'.repeat(64),
      candidateSourceHash: '6'.repeat(64),
      baseDataRootHash: '7'.repeat(64),
      candidateDataRootHash: '8'.repeat(64),
      freshDataRoots: true,
      freshSessions: true,
      cacheResetBetweenPairs: true,
      coldWarmProtocol: 'one_cold_warmup_then_three_warm_pairs',
      pairCount: 12,
      pairResetReceipts,
    };
    const expected = {
      baseUrl: receipt.baseUrl,
      candidateUrl: receipt.candidateUrl,
      runtime: 'openai-agents-sdk' as const,
      candidateId: 'task6' as const,
      candidateConfigFingerprint: CANDIDATE_CONFIG_FINGERPRINT,
      outputRunNonce,
      nowMs,
    };
    expect(parseExternalLifecycleReceipt(receipt, {
      ...expected,
    })).toMatchObject({pairCount: 12, freshDataRoots: true, outputRunNonce});
    const receiptPath = path.join(backendRoot, 'lifecycle.json');
    await fsp.writeFile(receiptPath, JSON.stringify(receipt));
    const options = parseAgentLatencyArgs([
      '--base-url', receipt.baseUrl,
      '--candidate-url', receipt.candidateUrl,
      '--runtime', 'openai-agents-sdk',
      '--candidate', 'task6',
      '--candidate-config-fingerprint', CANDIDATE_CONFIG_FINGERPRINT,
      '--output-run-nonce', outputRunNonce,
      '--output-dir', 'test-output/runtime-concurrency/lifecycle-run',
      '--lifecycle-receipt', receiptPath,
    ], {backendRoot, nowMs});
    expect(options.lifecycleReceipt).toMatchObject({
      baseServerIdentityHash: '1'.repeat(64), candidateDataRootHash: '8'.repeat(64), pairCount: 12,
    });
    expect(() => parseExternalLifecycleReceipt({...receipt, generatedAtMs: nowMs - 11 * 60_000}, {
      ...expected,
    })).toThrow('benchmark_lifecycle_receipt_stale');
    expect(() => parseExternalLifecycleReceipt({...receipt, candidateDataRootHash: receipt.baseDataRootHash}, {
      ...expected,
    })).toThrow('benchmark_lifecycle_receipt_data_roots_not_distinct');
    expect(() => parseExternalLifecycleReceipt({...receipt, pairCount: 11}, {
      ...expected,
    })).toThrow('benchmark_lifecycle_receipt_pair_count_mismatch');
    expect(() => parseExternalLifecycleReceipt({...receipt, outputRunNonce: 'a'.repeat(64)}, {
      ...expected,
    })).toThrow('benchmark_lifecycle_receipt_output_nonce_mismatch');
    expect(() => parseExternalLifecycleReceipt({...receipt, candidateId: 'task4'}, {
      ...expected,
    })).toThrow('benchmark_lifecycle_receipt_candidate_mismatch');
    const wrongReset = pairResetReceipts.map((entry, index) => index === 1
      ? {...entry, cacheState: 'cold' as const}
      : entry);
    expect(() => parseExternalLifecycleReceipt({...receipt, pairResetReceipts: wrongReset}, {
      ...expected,
    })).toThrow('benchmark_lifecycle_receipt_pair_reset_coverage_mismatch');
  });

  it('keeps parsing read-only and atomically creates the missing ignored output root at execution', async () => {
    const backendRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-latency-empty-'));
    tempDirs.push(backendRoot);
    const options = parseAgentLatencyArgs([
      '--base-url', 'http://127.0.0.1:10000',
      '--candidate-url', 'http://127.0.0.1:10001',
      '--runtime', 'claude-agent-sdk',
      '--output-dir', 'test-output/runtime-concurrency/fresh-run',
    ], {backendRoot});

    expect(fs.existsSync(path.join(backendRoot, 'test-output'))).toBe(false);
    expect(fs.existsSync(options.outputDir)).toBe(false);
    await prepareBenchmarkOutputDirectory(options);
    expect(fs.statSync(path.join(backendRoot, 'test-output', 'runtime-concurrency')).isDirectory()).toBe(true);
    expect(fs.statSync(options.outputDir).isDirectory()).toBe(true);
  });

  it('builds a literal-IP proxy-bypassing direct request with no pooled agent', () => {
    expect(buildDirectHttpRequestOptions('http://127.0.0.1:10000/api/agent/v1/analyze', 'POST')).toMatchObject({
      protocol: 'http:',
      hostname: '127.0.0.1',
      port: 10000,
      method: 'POST',
      path: '/api/agent/v1/analyze',
      agent: false,
    });
    expect(() => buildDirectHttpRequestOptions('http://localhost:10000/api')).toThrow('benchmark_target_url_not_loopback');
  });

  it.each([
    ['abort', 'benchmark_request_aborted'],
    ['request-error', 'native_request_failed'],
    ['close-before-response', 'benchmark_request_closed_before_response'],
    ['early-response', 'benchmark_redirect_forbidden'],
    ['normal-close', null],
  ] as const)('settles native HTTP lifecycle case %s exactly once', async (kind, expectedError) => {
    const request = new EventEmitter() as EventEmitter & {
      destroy: jest.Mock;
      end: jest.Mock;
      write: jest.Mock;
    };
    request.end = jest.fn();
    request.write = jest.fn();
    request.destroy = jest.fn(error => {
      if (error) queueMicrotask(() => request.emit('error', error));
    });
    let responseCallback: ((message: http.IncomingMessage) => void) | undefined;
    const requestSpy = jest.spyOn(http, 'request').mockImplementation(((
      _options: string | URL | http.RequestOptions,
      callback?: (message: http.IncomingMessage) => void,
    ) => {
      responseCallback = callback;
      return request;
    }) as unknown as typeof http.request);
    const controller = new AbortController();
    let settlements = 0;
    try {
      const pending = directHttpResponse('http://127.0.0.1:10000/api/test', {
        method: 'GET',
        signal: controller.signal,
      }).then(
        response => { settlements++; return {response}; },
        error => { settlements++; return {error: error as Error}; },
      );
      if (kind === 'abort') controller.abort(new Error('caller_aborted'));
      if (kind === 'request-error') request.emit('error', new Error('native_request_failed'));
      if (kind === 'close-before-response') request.emit('close');
      if (kind === 'early-response' || kind === 'normal-close') {
        const message = new PassThrough() as PassThrough & http.IncomingMessage;
        message.statusCode = kind === 'early-response' ? 302 : 204;
        message.headers = kind === 'early-response' ? {location: 'http://127.0.0.1:10001/redirect'} : {};
        responseCallback!(message);
        request.emit('response', message);
        message.end();
        request.emit('close');
      }
      const outcome = await Promise.race([
        pending,
        new Promise<never>((_, reject) => setTimeout(
          () => reject(new Error(`native_transport_did_not_settle:${kind}`)),
          250,
        )),
      ]);
      await new Promise(resolve => setImmediate(resolve));
      if (expectedError) expect(outcome).toMatchObject({error: {message: expectedError}});
      else expect(outcome).toMatchObject({response: {status: 204}});
      expect(settlements).toBe(1);
    } finally {
      requestSpy.mockRestore();
    }
  });

  it('handles a pre-aborted native request without an unhandled ClientRequest error', async () => {
    const backendRoot = await tempBackendRoot();
    const tracePath = path.join(backendRoot, 'trace.pftrace');
    await fsp.writeFile(tracePath, Buffer.from('trace'));
    const request = new EventEmitter() as EventEmitter & {
      destroy: jest.Mock;
      end: jest.Mock;
      write: jest.Mock;
    };
    request.end = jest.fn();
    request.write = jest.fn();
    request.destroy = jest.fn(error => queueMicrotask(() => request.emit('error', error)));
    const requestSpy = jest.spyOn(http, 'request').mockReturnValue(request as any);
    const controller = new AbortController();
    controller.abort(new Error('already_aborted'));
    try {
      await expect(runTargetBenchmarkCell({
        baseUrl: 'http://127.0.0.1:10000', runtime: 'openai-agents-sdk', candidate: 'task6',
        candidateConfigFingerprint: CANDIDATE_CONFIG_FINGERPRINT,
        scenario: {id: 'startup-full', traceId: 'android-startup-heavy', tracePath, query: '分析启动性能', mode: 'full'},
        repetition: 1, warmup: false, cacheState: 'warm', signal: controller.signal,
      })).rejects.toThrow('benchmark_request_aborted');
      await new Promise(resolve => setImmediate(resolve));
      expect(request.destroy).toHaveBeenCalledTimes(1);
    } finally {
      requestSpy.mockRestore();
    }
  });

  it.each(['abort', 'request-error', 'close-before-response', 'early-response'] as const)(
    'destroys and detaches the native upload stream exactly once on %s',
    async kind => {
    const backendRoot = await tempBackendRoot();
    const tracePath = path.join(backendRoot, 'trace.pftrace');
    await fsp.writeFile(tracePath, Buffer.from('trace'));
    const request = new PassThrough() as PassThrough & {setTimeout?: jest.Mock};
    const source = new PassThrough();
    const destroySpy = jest.spyOn(source, 'destroy');
    const controller = new AbortController();
    const requestSpy = jest.spyOn(http, 'request').mockImplementation(((
      _options: string | URL | http.RequestOptions,
      callback?: (message: http.IncomingMessage) => void,
    ) => {
      setImmediate(() => {
        if (kind === 'abort') controller.abort(new Error('caller_aborted'));
        if (kind === 'request-error') request.emit('error', new Error('upload_failed'));
        if (kind === 'close-before-response') request.emit('close');
        if (kind === 'early-response') {
          const message = new PassThrough() as PassThrough & http.IncomingMessage;
          message.statusCode = 400;
          message.headers = {'content-type': 'application/json'};
          callback!(message);
          request.emit('response', message);
          message.end(JSON.stringify({error: 'rejected'}));
        }
      });
      return request as any;
    }) as typeof http.request);
    const sourceSpy = jest.spyOn(fs, 'createReadStream').mockReturnValue(source as any);
    try {
      await expect(runTargetBenchmarkCell({
        baseUrl: 'http://127.0.0.1:10000', runtime: 'openai-agents-sdk', candidate: 'task6',
        candidateConfigFingerprint: CANDIDATE_CONFIG_FINGERPRINT,
        scenario: {id: 'startup-full', traceId: 'android-startup-heavy', tracePath, query: '分析启动性能', mode: 'full'},
        repetition: 1, warmup: false, cacheState: 'warm', signal: controller.signal,
      })).rejects.toThrow(kind === 'abort'
        ? 'benchmark_request_aborted'
        : kind === 'request-error'
          ? 'upload_failed'
          : kind === 'close-before-response'
            ? 'benchmark_request_closed_before_response'
            : 'benchmark_http_error:400');
      await new Promise(resolve => setImmediate(resolve));
      expect(destroySpy).toHaveBeenCalledTimes(1);
    } finally {
      sourceSpy.mockRestore();
      requestSpy.mockRestore();
    }
  });

  it('writes JSON atomically without leaving same-directory temporary artifacts', async () => {
    const backendRoot = await tempBackendRoot();
    const outputDir = path.join(backendRoot, 'test-output', 'runtime-concurrency', 'atomic');
    await fsp.mkdir(outputDir);
    const output = path.join(outputDir, 'receipt.json');
    await writeBenchmarkJsonAtomic(output, {schemaVersion: 1, status: 'ok'});
    expect(JSON.parse(await fsp.readFile(output, 'utf8'))).toEqual({schemaVersion: 1, status: 'ok'});
    expect((await fsp.readdir(outputDir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('rejects output writes when the created run directory is swapped to a symlink', async () => {
    const backendRoot = await tempBackendRoot();
    const options = parseAgentLatencyArgs([
      '--base-url', 'http://127.0.0.1:10000',
      '--candidate-url', 'http://127.0.0.1:10001',
      '--runtime', 'openai-agents-sdk',
      '--output-dir', 'test-output/runtime-concurrency/swap-run',
    ], {backendRoot});
    const identity = await prepareBenchmarkOutputDirectory(options);
    const moved = `${options.outputDir}-moved`;
    await fsp.rename(options.outputDir, moved);
    const external = await fsp.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-agent-latency-swap-'));
    tempDirs.push(external);
    await fsp.symlink(external, options.outputDir);
    await expect(writeBenchmarkJsonAtomic(
      path.join(options.outputDir, 'receipt.json'),
      {schemaVersion: 1},
      identity,
    )).rejects.toThrow('benchmark_output_dir_identity_changed');
    expect(await fsp.readdir(external)).toEqual([]);
  });

  it('bounds JSON responses and does not include response bodies in errors', async () => {
    const large = new Response(JSON.stringify({secret: 'x'.repeat(300)}), {
      status: 200,
      headers: {'content-type': 'application/json'},
    });
    await expect(readBoundedJsonResponse(large, {maxBytes: 64})).rejects.toThrow('benchmark_response_too_large');
  });

  it('cancels an oversized analyze body and still cleans the uploaded trace', async () => {
    const backendRoot = await tempBackendRoot();
    const tracePath = path.join(backendRoot, 'trace.pftrace');
    await fsp.writeFile(tracePath, Buffer.from('trace'));
    const responses = [
      new Response(JSON.stringify({success: true, trace: {id: 'trace-large', status: 'ready'}}), {status: 200}),
      new Response(JSON.stringify({secret: 'x'.repeat(500)}), {status: 200, headers: {'content-length': '513'}}),
      new Response('{"success":true}', {status: 200}),
    ];
    const fetchImpl: typeof fetch = jest.fn(async () => responses.shift()!) as typeof fetch;
    await expect(runTargetBenchmarkCell({
      baseUrl: 'http://127.0.0.1:10000', runtime: 'openai-agents-sdk', candidate: 'task6',
      candidateConfigFingerprint: CANDIDATE_CONFIG_FINGERPRINT,
      scenario: {id: 'startup-full', traceId: 'android-startup-heavy', tracePath, query: '分析启动性能', mode: 'full'},
      repetition: 1, warmup: false, cacheState: 'warm', fetchImpl, maxJsonBytes: 64,
    })).rejects.toThrow('benchmark_response_too_large');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(String((fetchImpl as jest.Mock).mock.calls[2][0])).toContain('/api/traces/trace-large');
  });

  it('keeps the request timeout active while a bounded JSON response body is read', async () => {
    const backendRoot = await tempBackendRoot();
    const tracePath = path.join(backendRoot, 'trace.pftrace');
    await fsp.writeFile(tracePath, Buffer.from('trace'));
    const fetchImpl: typeof fetch = jest.fn(async (_url, init) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            controller.error(new Error('aborted'));
          }, {once: true});
        },
      });
      return new Response(stream, {status: 200, headers: {'content-type': 'application/json'}});
    }) as typeof fetch;
    const outcome = await Promise.race([
      runTargetBenchmarkCell({
        baseUrl: 'http://127.0.0.1:10000',
        runtime: 'openai-agents-sdk',
        candidate: 'task6',
        candidateConfigFingerprint: CANDIDATE_CONFIG_FINGERPRINT,
        scenario: {
          id: 'startup-full',
          traceId: 'android-startup-heavy',
          tracePath,
          query: '分析启动性能',
          mode: 'full',
        },
        repetition: 1,
        warmup: false,
        cacheState: 'warm',
        fetchImpl,
        requestTimeoutMs: 10,
      }).then(() => 'unexpected_success', error => error instanceof Error ? error.message : String(error)),
      new Promise<string>(resolve => setTimeout(() => resolve('request_body_timeout_not_enforced'), 100)),
    ]);

    expect(outcome).toBe('benchmark_request_timeout');
  });

  it('propagates one external abort signal through SSE and still attempts both cleanup requests', async () => {
    const backendRoot = await tempBackendRoot();
    const tracePath = path.join(backendRoot, 'trace.pftrace');
    await fsp.writeFile(tracePath, Buffer.from('trace'));
    const controller = new AbortController();
    let call = 0;
    const fetchImpl: typeof fetch = jest.fn(async (_url, init) => {
      call++;
      if (call === 1) return new Response(JSON.stringify({success: true, trace: {id: 'trace-abort', status: 'ready'}}), {status: 200});
      if (call === 2) return new Response(JSON.stringify({success: true, sessionId: 'session-abort', runId: 'run-abort'}), {status: 200});
      if (call === 3) {
        const stream = new ReadableStream<Uint8Array>({
          start(streamController) {
            init?.signal?.addEventListener('abort', () => streamController.error(new Error('aborted')), {once: true});
          },
        });
        setTimeout(() => controller.abort(new Error('user_abort')), 10);
        return new Response(stream, {status: 200, headers: {'content-type': 'text/event-stream'}});
      }
      expect(init?.signal).not.toBe(controller.signal);
      expect(init?.signal?.aborted).toBe(false);
      return new Response('{"success":true}', {status: 200});
    }) as typeof fetch;

    await expect(runTargetBenchmarkCell({
      baseUrl: 'http://127.0.0.1:10000',
      runtime: 'openai-agents-sdk',
      candidate: 'task6',
      candidateConfigFingerprint: CANDIDATE_CONFIG_FINGERPRINT,
      scenario: {id: 'startup-full', traceId: 'android-startup-heavy', tracePath, query: '分析启动性能', mode: 'full'},
      repetition: 1,
      warmup: false,
      cacheState: 'warm',
      fetchImpl,
      signal: controller.signal,
      requestTimeoutMs: 1_000,
      streamTimeoutMs: 1_000,
    })).rejects.toThrow('benchmark_request_aborted');
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('uses structured API/SSE receipts and marks currently unavailable performance fields absent', async () => {
    const backendRoot = await tempBackendRoot();
    const tracePath = path.join(backendRoot, 'trace.pftrace');
    await fsp.writeFile(tracePath, Buffer.from('trace'));
    let now = 1_000;
    const responses = [
      new Response(JSON.stringify({success: true, trace: {id: 'trace-id', status: 'ready', processorStatus: 'ready'}}), {status: 200}),
      new Response(JSON.stringify({success: true, sessionId: 'session-id', runId: 'run-id'}), {status: 202}),
      new Response([
        'event: answer_token',
        'data: {"data":{"token":"not persisted"}}',
        '',
        'event: analysis_completed',
        `data: ${JSON.stringify({runId: 'run-id', data: {
          conclusion: 'provider prose not persisted',
          terminalRunStatus: 'completed',
          conclusionContract: conclusionContract(),
          claimVerificationResult: {status: 'passed', checkedClaimCount: 2, unsupportedClaimCount: 0},
          identityResolutions: [{identityRefId: 'identity:app-main', status: 'verified', target: {traceId: 'trace-id'}}],
          analysisReceipt: {
            runId: 'run-id',
            sessionId: 'session-id',
            traceId: 'trace-id',
            mode: 'full',
            resolvedMode: 'full',
            runtime: 'openai-agents-sdk',
            providerId: 'provider-deepseek',
            claimAudit: {verifiedClaims: 2, unsupportedClaims: 0},
            qualityGates: {
              finalReportContract: 'passed',
              claimVerification: 'passed',
              identityResolution: 'passed',
            },
          },
        }})}`,
        '',
      ].join('\n'), {status: 200, headers: {'content-type': 'text/event-stream'}}),
      new Response('{"success":true}', {status: 200}),
      new Response('{"success":true}', {status: 200}),
    ];
    const fetchImpl: typeof fetch = jest.fn(async (_input, init) => {
      expect(init?.redirect).toBe('error');
      const response = responses.shift();
      if (!response) throw new Error('unexpected_fetch');
      now += 100;
      return response;
    }) as typeof fetch;

    const result = await runTargetBenchmarkCell({
      baseUrl: 'http://127.0.0.1:10000',
      runtime: 'openai-agents-sdk',
      candidate: 'task6',
      candidateConfigFingerprint: CANDIDATE_CONFIG_FINGERPRINT,
      scenario: {
        id: 'startup-full',
        traceId: 'android-startup-heavy',
        tracePath,
        query: '分析启动性能',
        mode: 'full',
      },
      repetition: 1,
      warmup: false,
      cacheState: 'warm',
      fetchImpl,
      now: () => now,
      maxJsonBytes: 64 * 1024,
      maxSseBytes: 64 * 1024,
      requestTimeoutMs: 1_000,
      streamTimeoutMs: 1_000,
    });

    expect(result.runtime).toBe('openai-agents-sdk');
    expect(result.firstOutputMs).toBeGreaterThan(0);
    expect(result.model).toBeUndefined();
    expect(result.providerSnapshotHash).toBeUndefined();
    expect(result.providerUsage).toBeUndefined();
    expect(result.performance).toBeUndefined();
    expect(result.terminalOutcome).toBe('completed');
    expect(result.cleanup.session.success).toBe(true);
    expect(result.cleanup.trace.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain('provider prose');
    expect(JSON.stringify(result)).not.toContain('not persisted');
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('cleans up an uploaded trace when readiness validation fails before analyze', async () => {
    const backendRoot = await tempBackendRoot();
    const tracePath = path.join(backendRoot, 'trace.pftrace');
    await fsp.writeFile(tracePath, Buffer.from('trace'));
    const responses = [
      new Response(JSON.stringify({success: true, trace: {id: 'trace-not-ready', status: 'loading'}}), {status: 200}),
      new Response('{"success":true}', {status: 200}),
    ];
    const fetchImpl: typeof fetch = jest.fn(async () => responses.shift()!) as typeof fetch;
    await expect(runTargetBenchmarkCell({
      baseUrl: 'http://127.0.0.1:10000', runtime: 'openai-agents-sdk', candidate: 'task6',
      candidateConfigFingerprint: CANDIDATE_CONFIG_FINGERPRINT,
      scenario: {id: 'startup-full', traceId: 'android-startup-heavy', tracePath, query: '分析启动性能', mode: 'full'},
      repetition: 1, warmup: false, cacheState: 'warm', fetchImpl,
    })).rejects.toThrow('benchmark_trace_upload_not_ready');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String((fetchImpl as jest.Mock).mock.calls[1][0])).toContain('/api/traces/trace-not-ready');
  });

  it('rejects an uncorrelated terminal run after performing mandatory cleanup', async () => {
    const backendRoot = await tempBackendRoot();
    const tracePath = path.join(backendRoot, 'trace.pftrace');
    await fsp.writeFile(tracePath, Buffer.from('trace'));
    const terminal = {
      runId: 'wrong-run',
      data: {
        terminalRunStatus: 'completed',
        conclusionContract: conclusionContract(),
        claimVerificationResult: {status: 'passed', checkedClaimCount: 2, unsupportedClaimCount: 0},
        identityResolutions: [],
        analysisReceipt: {
          runId: 'run-id', sessionId: 'session-id', traceId: 'trace-id', mode: 'full', resolvedMode: 'full',
          runtime: 'openai-agents-sdk', providerId: 'provider-deepseek',
          claimAudit: {verifiedClaims: 2, unsupportedClaims: 0},
          qualityGates: {finalReportContract: 'passed', claimVerification: 'passed', identityResolution: 'passed'},
        },
      },
    };
    const responses = [
      new Response(JSON.stringify({success: true, trace: {id: 'trace-id', status: 'ready'}}), {status: 200}),
      new Response(JSON.stringify({success: true, sessionId: 'session-id', runId: 'run-id'}), {status: 200}),
      new Response(`event: analysis_completed\ndata: ${JSON.stringify(terminal)}\n\n`, {status: 200, headers: {'content-type': 'text/event-stream'}}),
      new Response('{"success":true}', {status: 200}),
      new Response('{"success":true}', {status: 200}),
    ];
    const fetchImpl: typeof fetch = jest.fn(async () => responses.shift()!) as typeof fetch;
    await expect(runTargetBenchmarkCell({
      baseUrl: 'http://127.0.0.1:10000', runtime: 'openai-agents-sdk', candidate: 'task6',
      candidateConfigFingerprint: CANDIDATE_CONFIG_FINGERPRINT,
      scenario: {id: 'startup-full', traceId: 'android-startup-heavy', tracePath, query: '分析启动性能', mode: 'full'},
      repetition: 1, warmup: false, cacheState: 'warm', fetchImpl,
    })).rejects.toThrow('benchmark_sse_terminal_run_id_mismatch');
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it('classifies SSE error/end/analysis_cancelled terminals and still performs cleanup', async () => {
    const backendRoot = await tempBackendRoot();
    const tracePath = path.join(backendRoot, 'trace.pftrace');
    await fsp.writeFile(tracePath, Buffer.from('trace'));
    for (const terminalEvent of ['error', 'end', 'analysis_cancelled']) {
      const responses = [
        new Response(JSON.stringify({success: true, trace: {id: `trace-${terminalEvent}`, status: 'ready'}}), {status: 200}),
        new Response(JSON.stringify({success: true, sessionId: `session-${terminalEvent}`, runId: `run-${terminalEvent}`}), {status: 200}),
        new Response(`event: ${terminalEvent}\ndata: ${JSON.stringify({runId: `run-${terminalEvent}`})}\n\n`, {status: 200, headers: {'content-type': 'text/event-stream'}}),
        new Response('{"success":true}', {status: 200}),
        new Response('{"success":true}', {status: 200}),
      ];
      const fetchImpl: typeof fetch = jest.fn(async () => responses.shift()!) as typeof fetch;
      await expect(runTargetBenchmarkCell({
        baseUrl: 'http://127.0.0.1:10000', runtime: 'openai-agents-sdk', candidate: 'task6',
        candidateConfigFingerprint: CANDIDATE_CONFIG_FINGERPRINT,
        scenario: {id: 'startup-full', traceId: 'android-startup-heavy', tracePath, query: '分析启动性能', mode: 'full'},
        repetition: 1, warmup: false, cacheState: 'warm', fetchImpl,
      })).rejects.toThrow(terminalEvent === 'error'
        ? 'benchmark_sse_error_event'
        : terminalEvent === 'end'
          ? 'benchmark_sse_end_without_analysis_completed'
          : 'benchmark_sse_analysis_cancelled');
      expect(fetchImpl).toHaveBeenCalledTimes(5);
    }
  });

  it('records cleanup failure on an otherwise completed cell', async () => {
    const backendRoot = await tempBackendRoot();
    const tracePath = path.join(backendRoot, 'trace.pftrace');
    await fsp.writeFile(tracePath, Buffer.from('trace'));
    const terminal = {
      runId: 'run-id',
      data: {
        terminalRunStatus: 'completed',
        conclusionContract: conclusionContract(),
        claimVerificationResult: {status: 'passed', checkedClaimCount: 2, unsupportedClaimCount: 0},
        identityResolutions: [],
        analysisReceipt: {
          runId: 'run-id', sessionId: 'session-id', traceId: 'trace-id', mode: 'full', resolvedMode: 'full',
          runtime: 'openai-agents-sdk', providerId: 'provider-deepseek',
          claimAudit: {verifiedClaims: 2, unsupportedClaims: 0},
          qualityGates: {finalReportContract: 'passed', claimVerification: 'passed', identityResolution: 'passed'},
        },
      },
    };
    const responses = [
      new Response(JSON.stringify({success: true, trace: {id: 'trace-id', status: 'ready'}}), {status: 200}),
      new Response(JSON.stringify({success: true, sessionId: 'session-id', runId: 'run-id'}), {status: 200}),
      new Response(`event: analysis_completed\ndata: ${JSON.stringify(terminal)}\n\n`, {status: 200, headers: {'content-type': 'text/event-stream'}}),
      new Response('{"success":false}', {status: 500}),
      new Response('{"success":true}', {status: 200}),
    ];
    const fetchImpl: typeof fetch = jest.fn(async () => responses.shift()!) as typeof fetch;
    const result = await runTargetBenchmarkCell({
      baseUrl: 'http://127.0.0.1:10000', runtime: 'openai-agents-sdk', candidate: 'task6',
      candidateConfigFingerprint: CANDIDATE_CONFIG_FINGERPRINT,
      scenario: {id: 'startup-full', traceId: 'android-startup-heavy', tracePath, query: '分析启动性能', mode: 'full'},
      repetition: 1, warmup: false, cacheState: 'warm', fetchImpl,
    });
    expect(result.cleanup.session).toMatchObject({attempted: true, success: false, status: 500});
    expect(result.cleanup.trace).toMatchObject({attempted: true, success: true, status: 200});
  });

  it('atomically preserves partial cells, pair order, stage, errors, and cleanup receipts on runner failure', async () => {
    const backendRoot = await tempBackendRoot();
    const options = parseAgentLatencyArgs([
      '--base-url', 'http://127.0.0.1:10000',
      '--candidate-url', 'http://127.0.0.1:10001',
      '--runtime', 'openai-agents-sdk',
      '--candidate', 'task4',
      '--candidate-config-fingerprint', CANDIDATE_CONFIG_FINGERPRINT,
      '--output-dir', 'test-output/runtime-concurrency/partial-run',
    ], {backendRoot});
    let calls = 0;
    await expect(runAgentLatencyBenchmark(options, {
      randomOrder: () => ['base', 'candidate'],
      executeCell: async input => {
        calls++;
        if (calls === 2) throw new Error('benchmark_injected_failure');
        const hashedQuery = queryHash(input.scenario.query);
        return cell({
          candidate: input.candidate,
          candidateConfigFingerprint: input.candidateConfigFingerprint,
          runtime: input.runtime,
          scenario: input.scenario.id,
          trace: input.scenario.traceId,
          queryHash: hashedQuery,
          mode: input.scenario.mode,
          repetition: input.repetition,
          warmup: input.warmup,
          cacheState: input.cacheState,
          targetBinding: {
            ...cell().targetBinding,
            uploadedTraceId: 'trace-partial', receiptTraceId: 'trace-partial',
            analyzeSessionId: 'session-partial', receiptSessionId: 'session-partial',
            analyzeRunId: 'run-partial', terminalRunId: 'run-partial', receiptRunId: 'run-partial',
            requestedQueryHash: hashedQuery, observedQueryHash: hashedQuery,
            requestedMode: input.scenario.mode, observedMode: input.scenario.mode,
            resolvedMode: input.scenario.mode === 'fast' ? 'quick' : 'full',
            requestedCandidateId: input.candidate,
            requestedCandidateConfigFingerprint: input.candidateConfigFingerprint,
            observedCandidateId: input.candidate,
            observedCandidateConfigFingerprint: input.candidateConfigFingerprint,
          },
        });
      },
    })).rejects.toThrow('benchmark_injected_failure');
    const failure = JSON.parse(await fsp.readFile(path.join(options.outputDir, 'failure.json'), 'utf8'));
    const partial = JSON.parse(await fsp.readFile(path.join(options.outputDir, 'partial.json'), 'utf8'));
    expect(failure).toMatchObject({status: 'FAILED', errors: ['benchmark_injected_failure']});
    expect(failure.completed.baseCells).toHaveLength(1);
    expect(failure.randomizedPairOrder).toHaveLength(0);
    expect(failure.warmupPairOrder).toHaveLength(1);
    expect(failure.cleanupReceipts).toHaveLength(1);
    expect(partial.completed.baseCells).toHaveLength(1);
    expect((await fsp.readdir(options.outputDir)).some(name => name.endsWith('.tmp'))).toBe(false);
  });

  it('keeps the minimal CLI unscoped and never loops or relabels one target as multiple candidates', async () => {
    const backendRoot = await tempBackendRoot();
    const options = parseAgentLatencyArgs([
      '--base-url', 'http://127.0.0.1:10000',
      '--candidate-url', 'http://127.0.0.1:10001',
      '--runtime', 'openai-agents-sdk',
      '--output-dir', 'test-output/runtime-concurrency/unscoped-run',
    ], {backendRoot});
    const executeCell = jest.fn(async () => {
      throw new Error('unscoped_runner_must_not_execute');
    });
    const result = await runAgentLatencyBenchmark(options, {executeCell});
    expect(executeCell).not.toHaveBeenCalled();
    expect(result.base.scope).toBeNull();
    expect(result.candidate.scope).toBeNull();
    expect(result.base.cells).toEqual([]);
    expect(result.candidate.cells).toEqual([]);
    expect(result.admissions).toEqual([]);
    expect(result.aggregates).toEqual([]);
  });

  it('reports local configuration signals without exposing credential values', () => {
    const availability = inspectLocalRuntimeAvailability({
      env: {
        DEEPSEEK_API_KEY: 'deepseek-secret',
        OPENAI_API_KEY: 'openai-secret',
        SMARTPERFETTO_PI_AGENT_CORE_MODEL_JSON: '{"apiKey":"pi-secret"}',
        SMARTPERFETTO_OPENCODE_MODEL_JSON: '{"apiKey":"opencode-secret"}',
        ANTHROPIC_API_KEY: 'anthropic-secret',
        QODER_BYOK_API_KEY: 'qoder-byok-secret',
      },
      commandExists: command => command === 'claude',
      fileExists: file => file.endsWith('qoder-auth.json'),
      homeDir: '/Users/example',
    });
    const serialized = JSON.stringify(availability);
    expect(serialized).not.toContain('deepseek-secret');
    expect(serialized).not.toContain('openai-secret');
    expect(serialized).not.toContain('pi-secret');
    expect(serialized).not.toContain('opencode-secret');
    expect(serialized).not.toContain('anthropic-secret');
    expect(serialized).not.toContain('qoder-byok-secret');
    expect(availability.scope).toBe('local_harness_only');
    expect(availability.qoder.status).toBe('NOT_AVAILABLE');
    expect(availability.qoder.reason).toContain('BYOK does not prove Qoder authentication');
  });
});
