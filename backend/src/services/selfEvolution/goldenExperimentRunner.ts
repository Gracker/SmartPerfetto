// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {
  EvalGoldenScoreV1,
  EvalPinnedEnvironmentV1,
} from '../../types/selfEvolution';
import {
  canonicalContentHash,
  canonicalJsonString,
  immutableCanonicalSnapshot,
} from './canonicalJson';
import type {
  GoldenExperimentCellV1,
  GoldenExperimentManifestV1,
  GoldenExperimentProfileV1,
} from './goldenExperimentContracts';
import {
  executionEvalCaseView,
  type GoldenTraceExecutionCaseV1,
  type GoldenTraceRegistryV1,
} from './goldenTraceRegistry';
import {
  parseGoldenTraceObservation,
  scoreGoldenTraceObservation,
  type GoldenTraceObservationV1,
} from './goldenTraceScorer';
import type {EvaluationUsageReceiptV1} from './evaluationTelemetry';

export interface GoldenExperimentActualRuntimeV1 {
  runtime: EvalPinnedEnvironmentV1['runtime'];
  providerId: string | null;
  model?: string;
  terminationReason: string;
}

export type GoldenExperimentExecutorResultV1 =
  | {
      status: 'completed';
      observation: GoldenTraceObservationV1;
      usageReceipt: EvaluationUsageReceiptV1;
      actual: GoldenExperimentActualRuntimeV1;
    }
  | {
      status: 'unavailable' | 'inconclusive' | 'failed';
      reason: string;
    };

export interface GoldenExperimentCellExecutor {
  execute(input: {
    cell: GoldenExperimentCellV1;
    executionCase: GoldenTraceExecutionCaseV1;
    profile: GoldenExperimentProfileV1;
    signal: AbortSignal;
  }): Promise<GoldenExperimentExecutorResultV1>;
}

export interface GoldenExperimentSemanticJudgeResultV1 {
  status: 'scored' | 'not_evaluable';
  hitRatio?: number;
  judgeReceiptHash?: string;
  reason?: string;
}

export interface GoldenExperimentSemanticJudge {
  judge(input: {
    cell: GoldenExperimentCellV1;
    goldenPoints: readonly string[];
    claims: GoldenTraceObservationV1['claims'];
  }): Promise<GoldenExperimentSemanticJudgeResultV1>;
}

export interface GoldenExperimentRuntimeReceiptV1 {
  schemaVersion: 1;
  actual: GoldenExperimentActualRuntimeV1;
  usageReceiptContentHash: string;
  contentHash: string;
}

export interface GoldenExperimentObservationReceiptV1 {
  schemaVersion: 1;
  observationContentHash: string;
  facts: number;
  evidence: number;
  claims: number;
  gaps: number;
  identities: number;
  causalEdges: number;
  contentHash: string;
}

export interface GoldenExperimentCellResultV1 {
  schemaVersion: 1;
  cellId: string;
  caseId: string;
  profileId: string | null;
  repeat: number;
  status: 'completed' | 'unavailable' | 'inconclusive' | 'failed';
  reason?: string;
  goldenScore?: EvalGoldenScoreV1;
  semanticScore?: GoldenExperimentSemanticJudgeResultV1;
  observationReceipt?: GoldenExperimentObservationReceiptV1;
  runtimeReceipt?: GoldenExperimentRuntimeReceiptV1;
  usage?: {
    tokens: number;
    wallclockMs: number;
    firstOutputMs?: number;
  };
  contentHash: string;
}

export interface GoldenExperimentSummaryV1 {
  schemaVersion: 1;
  cells: {
    total: number;
    completed: number;
    failed: number;
    inconclusive: number;
    unavailable: number;
  };
  assertions: {
    passed: number;
    failed: number;
    notEvaluable: number;
  };
  semantic: {
    scored: number;
    notEvaluable: number;
    meanHitRatio: number | null;
  };
  profiles: Record<string, {
    cells: number;
    medianTokens: number | null;
    p90Tokens: number | null;
    p95Tokens: number | null;
    medianWallclockMs: number | null;
    p90WallclockMs: number | null;
    p95WallclockMs: number | null;
    medianFirstOutputMs: number | null;
    p90FirstOutputMs: number | null;
    p95FirstOutputMs: number | null;
    failureRate: number;
  }>;
  comparison: {
    improved: number;
    regressed: number;
    unchanged: number;
    notEvaluable: number;
  };
  contentHash: string;
}

export interface GoldenExperimentArtifactWriter {
  writeManifest(manifest: GoldenExperimentManifestV1): void;
  writeCell(input: {
    experimentId: string;
    result: GoldenExperimentCellResultV1;
    usageReceipt?: EvaluationUsageReceiptV1;
  }): void;
  writeSummary(input: {
    experimentId: string;
    summary: GoldenExperimentSummaryV1;
  }): void;
}

function observationReceipt(
  observation: GoldenTraceObservationV1,
): GoldenExperimentObservationReceiptV1 {
  const withoutHash = {
    schemaVersion: 1 as const,
    observationContentHash: canonicalContentHash(observation),
    facts: Object.keys(observation.facts).length,
    evidence: observation.evidence.length,
    claims: observation.claims.length,
    gaps: observation.gaps.length,
    identities: Object.keys(observation.identities).length,
    causalEdges: observation.causalEdges.length,
  };
  return immutableCanonicalSnapshot({
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash),
  });
}

function goldenScore(
  score: Extract<ReturnType<typeof scoreGoldenTraceObservation>, {status: 'scored'}>,
): EvalGoldenScoreV1 {
  return {
    passed: score.passed,
    assertionCount: score.assertions.length,
    passedAssertions: score.summary.passed,
    failedAssertions: score.summary.failed,
    notEvaluableAssertions: score.summary.notEvaluable,
    blockers: score.blockers,
    contentHash: score.contentHash,
  };
}

function runtimeReceipt(input: {
  actual: GoldenExperimentActualRuntimeV1;
  usageReceipt: EvaluationUsageReceiptV1;
}): GoldenExperimentRuntimeReceiptV1 {
  const withoutHash = {
    schemaVersion: 1 as const,
    actual: input.actual,
    usageReceiptContentHash: input.usageReceipt.contentHash,
  };
  return immutableCanonicalSnapshot({
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash),
  });
}

function resultSnapshot(
  value: Omit<GoldenExperimentCellResultV1, 'contentHash'>,
): GoldenExperimentCellResultV1 {
  return immutableCanonicalSnapshot({
    ...value,
    contentHash: canonicalContentHash(value),
  });
}

function percentile(values: readonly number[], ratio: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)];
}

function profileSummary(
  results: readonly GoldenExperimentCellResultV1[],
) {
  const tokens = results.flatMap(item => item.usage ? [item.usage.tokens] : []);
  const wallclock = results.flatMap(item =>
    item.usage ? [item.usage.wallclockMs] : []);
  const firstOutput = results.flatMap(item =>
    item.usage?.firstOutputMs === undefined ? [] : [item.usage.firstOutputMs]);
  const failed = results.filter(item =>
    item.status !== 'completed'
    || item.goldenScore?.passed === false
    || (
      item.semanticScore?.status === 'scored'
      && (item.semanticScore.hitRatio ?? 0) < 1
    )).length;
  return {
    cells: results.length,
    medianTokens: percentile(tokens, 0.5),
    p90Tokens: percentile(tokens, 0.9),
    p95Tokens: percentile(tokens, 0.95),
    medianWallclockMs: percentile(wallclock, 0.5),
    p90WallclockMs: percentile(wallclock, 0.9),
    p95WallclockMs: percentile(wallclock, 0.95),
    medianFirstOutputMs: percentile(firstOutput, 0.5),
    p90FirstOutputMs: percentile(firstOutput, 0.9),
    p95FirstOutputMs: percentile(firstOutput, 0.95),
    failureRate: results.length === 0 ? 0 : failed / results.length,
  };
}

export function summarizeGoldenExperiment(input: {
  baselineProfileId: string | null;
  results: readonly GoldenExperimentCellResultV1[];
}): GoldenExperimentSummaryV1 {
  const statusCount = (status: GoldenExperimentCellResultV1['status']) =>
    input.results.filter(item => item.status === status).length;
  const profiles: GoldenExperimentSummaryV1['profiles'] = {};
  for (const profileId of [...new Set(input.results.flatMap(item =>
    item.profileId === null ? [] : [item.profileId]))].sort()) {
    profiles[profileId] = profileSummary(
      input.results.filter(item => item.profileId === profileId),
    );
  }
  const comparison = {
    improved: 0,
    regressed: 0,
    unchanged: 0,
    notEvaluable: 0,
  };
  if (input.baselineProfileId) {
    const baseline = new Map(input.results
      .filter(item => item.profileId === input.baselineProfileId)
      .map(item => [`${item.caseId}\0${item.repeat}`, item]));
    for (const candidate of input.results.filter(item =>
      item.profileId !== null && item.profileId !== input.baselineProfileId)) {
      const base = baseline.get(`${candidate.caseId}\0${candidate.repeat}`);
      if (
        !base
        || base.status !== 'completed'
        || candidate.status !== 'completed'
        || !base.goldenScore
        || !candidate.goldenScore
      ) {
        comparison.notEvaluable += 1;
      } else if (!base.goldenScore.passed && candidate.goldenScore.passed) {
        comparison.improved += 1;
      } else if (base.goldenScore.passed && !candidate.goldenScore.passed) {
        comparison.regressed += 1;
      } else if (
        (base.semanticScore?.status === 'scored')
          !== (candidate.semanticScore?.status === 'scored')
      ) {
        comparison.notEvaluable += 1;
      } else if (
        base.semanticScore?.status === 'scored'
        && candidate.semanticScore?.status === 'scored'
        && (candidate.semanticScore.hitRatio ?? 0)
          > (base.semanticScore.hitRatio ?? 0)
      ) {
        comparison.improved += 1;
      } else if (
        base.semanticScore?.status === 'scored'
        && candidate.semanticScore?.status === 'scored'
        && (candidate.semanticScore.hitRatio ?? 0)
          < (base.semanticScore.hitRatio ?? 0)
      ) {
        comparison.regressed += 1;
      } else {
        comparison.unchanged += 1;
      }
    }
  }
  const withoutHash = {
    schemaVersion: 1 as const,
    cells: {
      total: input.results.length,
      completed: statusCount('completed'),
      failed: statusCount('failed'),
      inconclusive: statusCount('inconclusive'),
      unavailable: statusCount('unavailable'),
    },
    assertions: {
      passed: input.results.reduce(
        (sum, item) => sum + (item.goldenScore?.passedAssertions ?? 0),
        0,
      ),
      failed: input.results.reduce(
        (sum, item) => sum + (item.goldenScore?.failedAssertions ?? 0),
        0,
      ),
      notEvaluable: input.results.reduce(
        (sum, item) => sum + (item.goldenScore?.notEvaluableAssertions ?? 0),
        0,
      ),
    },
    semantic: {
      scored: input.results.filter(item =>
        item.semanticScore?.status === 'scored').length,
      notEvaluable: input.results.filter(item =>
        item.semanticScore?.status === 'not_evaluable').length,
      meanHitRatio: (() => {
        const ratios = input.results.flatMap(item =>
          item.semanticScore?.status === 'scored'
            ? [item.semanticScore.hitRatio ?? 0]
            : []);
        return ratios.length === 0
          ? null
          : ratios.reduce((sum, value) => sum + value, 0) / ratios.length;
      })(),
    },
    profiles,
    comparison,
  };
  return immutableCanonicalSnapshot({
    ...withoutHash,
    contentHash: canonicalContentHash(withoutHash),
  });
}

function matchingActual(
  profile: GoldenExperimentProfileV1,
  actual: GoldenExperimentActualRuntimeV1,
): boolean {
  return /^[a-z][a-z0-9_:-]{0,79}$/.test(actual.terminationReason)
    && canonicalJsonString({
      runtime: actual.runtime,
      providerId: actual.providerId,
      model: actual.model ?? null,
    }) === canonicalJsonString({
      runtime: profile.pinned.runtime,
      providerId: profile.pinned.providerId,
      model: profile.pinned.model ?? null,
    });
}

function safeReason(value: string, fallback: string): string {
  return /^[a-z][a-z0-9_:-]{0,159}$/.test(value) ? value : fallback;
}

function validUsageReceipt(
  receipt: EvaluationUsageReceiptV1,
  profile: GoldenExperimentProfileV1,
  terminationReason: string,
): boolean {
  const {contentHash, ...withoutHash} = receipt;
  return /^[0-9a-f]{64}$/.test(contentHash)
    && canonicalContentHash(withoutHash) === contentHash
    && receipt.exceeded === null
    && receipt.tokens.guarantee !== 'unavailable'
    && receipt.traceProcessorCpu.guarantee !== 'unavailable'
    && (
      receipt.firstOutput?.guarantee === 'observed'
      || receipt.firstOutput?.guarantee === 'not_applicable'
    )
    && receipt.termination?.guarantee === 'observed'
    && receipt.termination.reason === terminationReason
    && receipt.tokens.used <= profile.budget.maxTokens
    && receipt.toolCalls.used <= profile.budget.maxToolCalls
    && receipt.wallclock.usedMs <= profile.budget.maxWallclockMs
    && receipt.traceProcessorCpu.usedMs
      <= profile.budget.maxTraceProcessorCpuMs;
}

export async function runGoldenExperiment(input: {
  manifest: GoldenExperimentManifestV1;
  registry: GoldenTraceRegistryV1;
  executor: GoldenExperimentCellExecutor;
  semanticJudge?: GoldenExperimentSemanticJudge;
  artifactStore?: GoldenExperimentArtifactWriter;
  signal?: AbortSignal;
}): Promise<{
  manifest: GoldenExperimentManifestV1;
  results: GoldenExperimentCellResultV1[];
  summary: GoldenExperimentSummaryV1;
}> {
  const {contentHash: manifestHash, ...manifestWithoutHash} = input.manifest;
  if (
    !/^gx-[0-9a-f]{32}$/.test(input.manifest.experimentId)
    || canonicalContentHash(manifestWithoutHash) !== manifestHash
    || new Set(input.manifest.cells.map(cell => cell.cellId)).size
      !== input.manifest.cells.length
  ) {
    throw new Error('golden_experiment_manifest_invalid');
  }
  if (input.manifest.registryContentHash !== canonicalContentHash(input.registry)) {
    throw new Error('golden_experiment_registry_mismatch');
  }
  const profiles = new Map(input.manifest.profiles.map(item => [item.profileId, item]));
  const cases = new Map(input.registry.cases.map(item => [item.caseId, item]));
  const signal = input.signal ?? new AbortController().signal;
  input.artifactStore?.writeManifest(input.manifest);
  const results: GoldenExperimentCellResultV1[] = [];
  for (const cell of input.manifest.cells) {
    if (signal.aborted) throw new Error('golden_experiment_cancelled');
    const evalCase = cases.get(cell.caseId);
    if (!evalCase || canonicalContentHash(evalCase) !== cell.caseContentHash) {
      throw new Error('golden_experiment_case_mismatch');
    }
    if (cell.execution === 'deterministic_contract') {
      const result = resultSnapshot({
        schemaVersion: 1,
        cellId: cell.cellId,
        caseId: cell.caseId,
        profileId: null,
        repeat: cell.repeat,
        status: 'completed',
        reason: 'contract_validated',
      });
      results.push(result);
      input.artifactStore?.writeCell({
        experimentId: input.manifest.experimentId,
        result,
      });
      continue;
    }
    const profile = cell.profileId ? profiles.get(cell.profileId) : undefined;
    if (!profile) throw new Error('golden_experiment_cell_profile_missing');
    let execution: GoldenExperimentExecutorResultV1;
    try {
      execution = await input.executor.execute({
        cell,
        executionCase: executionEvalCaseView(evalCase),
        profile,
        signal,
      });
    } catch (error) {
      execution = {
        status: 'failed',
        reason: safeReason(
          error instanceof Error ? error.message : String(error),
          'golden_experiment_executor_failed',
        ),
      };
    }
    if (execution.status !== 'completed') {
      const result = resultSnapshot({
        schemaVersion: 1,
        cellId: cell.cellId,
        caseId: cell.caseId,
        profileId: cell.profileId,
        repeat: cell.repeat,
        status: execution.status,
        reason: safeReason(
          execution.reason,
          'golden_experiment_executor_reason_invalid',
        ),
      });
      results.push(result);
      input.artifactStore?.writeCell({
        experimentId: input.manifest.experimentId,
        result,
      });
      continue;
    }
    if (
      !matchingActual(profile, execution.actual)
      || !validUsageReceipt(
        execution.usageReceipt,
        profile,
        execution.actual.terminationReason,
      )
    ) {
      const result = resultSnapshot({
        schemaVersion: 1,
        cellId: cell.cellId,
        caseId: cell.caseId,
        profileId: cell.profileId,
        repeat: cell.repeat,
        status: 'inconclusive',
        reason: !matchingActual(profile, execution.actual)
          ? 'golden_experiment_runtime_identity_mismatch'
          : 'golden_experiment_usage_receipt_invalid',
      });
      results.push(result);
      input.artifactStore?.writeCell({
        experimentId: input.manifest.experimentId,
        result,
      });
      continue;
    }
    const observation = parseGoldenTraceObservation(execution.observation);
    const deterministic = scoreGoldenTraceObservation(
      evalCase.groundTruth,
      observation,
    );
    if (deterministic.status !== 'scored') {
      throw new Error(deterministic.reason);
    }
    let semanticScore: GoldenExperimentSemanticJudgeResultV1 | undefined;
    if ((evalCase.goldenPoints?.length ?? 0) > 0) {
      semanticScore = input.semanticJudge
        ? await input.semanticJudge.judge({
            cell,
            goldenPoints: evalCase.goldenPoints!,
            claims: observation.claims,
          })
        : {status: 'not_evaluable', reason: 'semantic_judge_unavailable'};
      if (
        semanticScore.status === 'scored'
        && (
          typeof semanticScore.hitRatio !== 'number'
          || semanticScore.hitRatio < 0
          || semanticScore.hitRatio > 1
          || !/^[0-9a-f]{64}$/.test(semanticScore.judgeReceiptHash ?? '')
        )
      ) {
        throw new Error('golden_experiment_semantic_score_invalid');
      }
      if (
        semanticScore.status === 'not_evaluable'
        && !safeReason(
          semanticScore.reason ?? '',
          '',
        )
      ) {
        throw new Error('golden_experiment_semantic_reason_invalid');
      }
    }
    const receipt = observationReceipt(observation);
    const runtime = runtimeReceipt({
      actual: execution.actual,
      usageReceipt: execution.usageReceipt,
    });
    const result = resultSnapshot({
      schemaVersion: 1,
      cellId: cell.cellId,
      caseId: cell.caseId,
      profileId: cell.profileId,
      repeat: cell.repeat,
      status: 'completed',
      goldenScore: goldenScore(deterministic),
      ...(semanticScore ? {semanticScore} : {}),
      observationReceipt: receipt,
      runtimeReceipt: runtime,
      usage: {
        tokens: execution.usageReceipt.tokens.used,
        wallclockMs: execution.usageReceipt.wallclock.usedMs,
        ...(execution.usageReceipt.firstOutput?.usedMs === undefined
          ? {}
          : {firstOutputMs: execution.usageReceipt.firstOutput.usedMs}),
      },
    });
    results.push(result);
    input.artifactStore?.writeCell({
      experimentId: input.manifest.experimentId,
      result,
      usageReceipt: execution.usageReceipt,
    });
  }
  const summary = summarizeGoldenExperiment({
    baselineProfileId: input.manifest.baselineProfileId,
    results,
  });
  input.artifactStore?.writeSummary({
    experimentId: input.manifest.experimentId,
    summary,
  });
  return immutableCanonicalSnapshot({
    manifest: input.manifest,
    results,
    summary,
  });
}
