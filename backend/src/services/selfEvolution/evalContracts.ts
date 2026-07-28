// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {isProductionAgentRuntimeKind} from '../../agentRuntime/runtimeKinds';
import type {
  EvalCaseV1,
  EvalPinnedEnvironmentV1,
  EvalScoreV1,
  FeedbackDimension,
  RunManifestScope,
} from '../../types/selfEvolution';
import {
  FEEDBACK_NEGATIVE_DIMENSIONS,
  FEEDBACK_POSITIVE_DIMENSIONS,
} from '../../types/selfEvolution';
import {
  canonicalContentHash,
  immutableCanonicalSnapshot,
} from './canonicalJson';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const FEEDBACK_DIMENSIONS = new Set<FeedbackDimension>([
  ...FEEDBACK_NEGATIVE_DIMENSIONS,
  ...FEEDBACK_POSITIVE_DIMENSIONS,
]);

function record(value: unknown, error: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(error);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  error: string,
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some(key => !allowedKeys.has(key))) {
    throw new Error(error);
  }
}

function nonemptyString(value: unknown, error: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(error);
  }
  return value;
}

function optionalNonemptyString(value: unknown, error: string): string | undefined {
  return value === undefined ? undefined : nonemptyString(value, error);
}

function nonnegativeInteger(value: unknown, error: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(error);
  }
  return value as number;
}

function boundedRatio(value: unknown, error: string): number {
  if (
    typeof value !== 'number'
    || !Number.isFinite(value)
    || value < 0
    || value > 1
  ) {
    throw new Error(error);
  }
  return value;
}

function booleanValue(value: unknown, error: string): boolean {
  if (typeof value !== 'boolean') throw new Error(error);
  return value;
}

function parseScope(value: unknown): RunManifestScope {
  const scope = record(value, 'eval_scope_invalid');
  exactKeys(scope, ['tenantId', 'workspaceId'], 'eval_scope_unknown_field');
  return {
    tenantId: nonemptyString(scope.tenantId, 'eval_scope_tenant_invalid'),
    workspaceId: nonemptyString(scope.workspaceId, 'eval_scope_workspace_invalid'),
  };
}

function parsePinned(value: unknown): EvalPinnedEnvironmentV1 {
  const pinned = record(value, 'eval_pinned_invalid');
  exactKeys(pinned, [
    'runtime',
    'providerId',
    'model',
    'outputLanguage',
    'toolAllowlistHash',
    'injections',
    'overlayGeneration',
  ], 'eval_pinned_unknown_field');
  if (!isProductionAgentRuntimeKind(pinned.runtime)) {
    throw new Error('eval_pinned_runtime_invalid');
  }
  if (pinned.providerId !== null && typeof pinned.providerId !== 'string') {
    throw new Error('eval_pinned_provider_invalid');
  }
  if (typeof pinned.providerId === 'string' && !pinned.providerId.trim()) {
    throw new Error('eval_pinned_provider_invalid');
  }
  if (!['on', 'off', 'selective'].includes(String(pinned.injections))) {
    throw new Error('eval_pinned_injections_invalid');
  }
  const toolAllowlistHash = nonemptyString(
    pinned.toolAllowlistHash,
    'eval_pinned_tool_allowlist_hash_invalid',
  );
  if (!SHA256_PATTERN.test(toolAllowlistHash)) {
    throw new Error('eval_pinned_tool_allowlist_hash_invalid');
  }
  return {
    runtime: pinned.runtime,
    providerId: pinned.providerId,
    ...(pinned.model === undefined
      ? {}
      : {model: nonemptyString(pinned.model, 'eval_pinned_model_invalid')}),
    outputLanguage: nonemptyString(
      pinned.outputLanguage,
      'eval_pinned_output_language_invalid',
    ),
    toolAllowlistHash,
    injections: pinned.injections as EvalPinnedEnvironmentV1['injections'],
    overlayGeneration: nonemptyString(
      pinned.overlayGeneration,
      'eval_pinned_overlay_generation_invalid',
    ),
  };
}

function parseTrace(value: unknown): EvalCaseV1['traces'][number] {
  const trace = record(value, 'eval_case_trace_invalid');
  exactKeys(
    trace,
    ['role', 'corpusId', 'catalogAlias', 'contentHash'],
    'eval_case_trace_unknown_field',
  );
  if (trace.role !== 'current' && trace.role !== 'reference') {
    throw new Error('eval_case_trace_role_invalid');
  }
  const corpusId = optionalNonemptyString(
    trace.corpusId,
    'eval_case_trace_corpus_id_invalid',
  );
  const catalogAlias = optionalNonemptyString(
    trace.catalogAlias,
    'eval_case_trace_catalog_alias_invalid',
  );
  if (!corpusId && !catalogAlias) {
    throw new Error('eval_case_trace_locator_required');
  }
  const contentHash = nonemptyString(
    trace.contentHash,
    'eval_case_trace_content_hash_invalid',
  );
  if (!SHA256_PATTERN.test(contentHash)) {
    throw new Error('eval_case_trace_content_hash_invalid');
  }
  return {
    role: trace.role,
    ...(corpusId ? {corpusId} : {}),
    ...(catalogAlias ? {catalogAlias} : {}),
    contentHash,
  };
}

function parseFeedbackDimensions(value: unknown): FeedbackDimension[] {
  if (!Array.isArray(value)) {
    throw new Error('eval_case_label_dimensions_invalid');
  }
  const dimensions = value.map(dimension => {
    if (!FEEDBACK_DIMENSIONS.has(dimension as FeedbackDimension)) {
      throw new Error('eval_case_label_dimension_invalid');
    }
    return dimension as FeedbackDimension;
  });
  if (new Set(dimensions).size !== dimensions.length) {
    throw new Error('eval_case_label_dimension_duplicate');
  }
  return dimensions;
}

export function parseEvalCase(value: unknown): EvalCaseV1 {
  const candidate = record(value, 'eval_case_invalid');
  exactKeys(candidate, [
    'schemaVersion',
    'caseId',
    'evalSetId',
    'origin',
    'sourceRunId',
    'scope',
    'traces',
    'query',
    'analysisMode',
    'expectedScene',
    'label',
    'goldenPoints',
    'expectedRubricVersion',
    'split',
    'createdAt',
  ], 'eval_case_unknown_field');
  if (candidate.schemaVersion !== 1) {
    throw new Error('eval_case_schema_version_invalid');
  }
  if (!['labeled_run', 'synthetic_seed', 'manual_golden'].includes(String(candidate.origin))) {
    throw new Error('eval_case_origin_invalid');
  }
  if (!Array.isArray(candidate.traces) || candidate.traces.length < 1 || candidate.traces.length > 2) {
    throw new Error('eval_case_traces_invalid');
  }
  const traces = candidate.traces.map(parseTrace);
  if (
    traces.filter(trace => trace.role === 'current').length !== 1
    || traces.filter(trace => trace.role === 'reference').length > 1
  ) {
    throw new Error('eval_case_trace_roles_invalid');
  }
  if (candidate.analysisMode !== 'fast' && candidate.analysisMode !== 'full') {
    throw new Error('eval_case_analysis_mode_invalid');
  }
  if (!['train', 'validation', 'holdout'].includes(String(candidate.split))) {
    throw new Error('eval_case_split_invalid');
  }

  let label: EvalCaseV1['label'];
  if (candidate.label !== undefined) {
    const rawLabel = record(candidate.label, 'eval_case_label_invalid');
    exactKeys(rawLabel, ['rating', 'dimensions'], 'eval_case_label_unknown_field');
    if (rawLabel.rating !== 'positive' && rawLabel.rating !== 'negative') {
      throw new Error('eval_case_label_rating_invalid');
    }
    label = {
      rating: rawLabel.rating,
      dimensions: parseFeedbackDimensions(rawLabel.dimensions),
    };
  }

  let goldenPoints: string[] | undefined;
  if (candidate.goldenPoints !== undefined) {
    if (!Array.isArray(candidate.goldenPoints) || candidate.goldenPoints.length === 0) {
      throw new Error('eval_case_golden_points_invalid');
    }
    goldenPoints = candidate.goldenPoints.map(point =>
      nonemptyString(point, 'eval_case_golden_point_invalid'));
  }

  const createdAt = nonemptyString(candidate.createdAt, 'eval_case_created_at_invalid');
  if (!Number.isFinite(Date.parse(createdAt))) {
    throw new Error('eval_case_created_at_invalid');
  }

  return immutableCanonicalSnapshot({
    schemaVersion: 1,
    caseId: nonemptyString(candidate.caseId, 'eval_case_id_invalid'),
    evalSetId: nonemptyString(candidate.evalSetId, 'eval_set_id_invalid'),
    origin: candidate.origin as EvalCaseV1['origin'],
    ...(candidate.sourceRunId === undefined
      ? {}
      : {
          sourceRunId: nonemptyString(
            candidate.sourceRunId,
            'eval_case_source_run_id_invalid',
          ),
        }),
    scope: parseScope(candidate.scope),
    traces,
    query: nonemptyString(candidate.query, 'eval_case_query_invalid'),
    analysisMode: candidate.analysisMode,
    ...(candidate.expectedScene === undefined
      ? {}
      : {
          expectedScene: nonemptyString(
            candidate.expectedScene,
            'eval_case_expected_scene_invalid',
          ),
        }),
    ...(label ? {label} : {}),
    ...(goldenPoints ? {goldenPoints} : {}),
    ...(candidate.expectedRubricVersion === undefined
      ? {}
      : {
          expectedRubricVersion: nonemptyString(
            candidate.expectedRubricVersion,
            'eval_case_rubric_version_invalid',
          ),
        }),
    split: candidate.split as EvalCaseV1['split'],
    createdAt,
  } satisfies EvalCaseV1);
}

export function parseEvalScore(value: unknown): EvalScoreV1 {
  const score = record(value, 'eval_score_invalid');
  exactKeys(score, [
    'schemaVersion',
    'caseId',
    'evalSetId',
    'runId',
    'runManifestId',
    'attempt',
    'role',
    'candidateId',
    'scope',
    'pinned',
    'availability',
    'l0',
    'l1',
    'l2',
    'l3',
  ], 'eval_score_unknown_field');
  if (score.schemaVersion !== 1) {
    throw new Error('eval_score_schema_version_invalid');
  }
  if (score.role !== 'baseline' && score.role !== 'candidate') {
    throw new Error('eval_score_role_invalid');
  }
  if (score.availability !== 'available' && score.availability !== 'unavailable') {
    throw new Error('eval_score_availability_invalid');
  }
  const attempt = nonnegativeInteger(score.attempt, 'eval_score_attempt_invalid');
  if (attempt < 1) throw new Error('eval_score_attempt_invalid');

  const l0 = record(score.l0, 'eval_score_l0_invalid');
  exactKeys(
    l0,
    ['runOk', 'sqlErrorFree', 'reportContractPass', 'skillCrashFree'],
    'eval_score_l0_unknown_field',
  );
  const l1 = record(score.l1, 'eval_score_l1_invalid');
  exactKeys(
    l1,
    ['claimVerifiedRatio', 'unsupportedClaims', 'evidenceAnchors'],
    'eval_score_l1_unknown_field',
  );
  const l3 = record(score.l3, 'eval_score_l3_invalid');
  exactKeys(
    l3,
    ['turns', 'wallclockMs', 'estimatedTokens', 'toolCalls'],
    'eval_score_l3_unknown_field',
  );

  let l2: EvalScoreV1['l2'];
  if (score.l2 !== undefined) {
    const rawL2 = record(score.l2, 'eval_score_l2_invalid');
    exactKeys(
      rawL2,
      ['goldenPointHitRatio', 'appliedRubricVersion', 'judgeNotes'],
      'eval_score_l2_unknown_field',
    );
    l2 = {
      goldenPointHitRatio: boundedRatio(
        rawL2.goldenPointHitRatio,
        'eval_score_l2_ratio_invalid',
      ),
      appliedRubricVersion: nonemptyString(
        rawL2.appliedRubricVersion,
        'eval_score_l2_rubric_invalid',
      ),
      ...(rawL2.judgeNotes === undefined
        ? {}
        : {
            judgeNotes: nonemptyString(
              rawL2.judgeNotes,
              'eval_score_l2_notes_invalid',
            ),
          }),
    };
  }

  return immutableCanonicalSnapshot({
    schemaVersion: 1,
    caseId: nonemptyString(score.caseId, 'eval_score_case_id_invalid'),
    evalSetId: nonemptyString(score.evalSetId, 'eval_score_eval_set_id_invalid'),
    runId: nonemptyString(score.runId, 'eval_score_run_id_invalid'),
    runManifestId: nonemptyString(
      score.runManifestId,
      'eval_score_run_manifest_id_invalid',
    ),
    attempt,
    role: score.role,
    ...(score.candidateId === undefined
      ? {}
      : {
          candidateId: nonemptyString(
            score.candidateId,
            'eval_score_candidate_id_invalid',
          ),
        }),
    scope: parseScope(score.scope),
    pinned: parsePinned(score.pinned),
    availability: score.availability,
    l0: {
      runOk: booleanValue(l0.runOk, 'eval_score_l0_run_ok_invalid'),
      sqlErrorFree: booleanValue(
        l0.sqlErrorFree,
        'eval_score_l0_sql_error_free_invalid',
      ),
      reportContractPass: booleanValue(
        l0.reportContractPass,
        'eval_score_l0_report_contract_invalid',
      ),
      skillCrashFree: booleanValue(
        l0.skillCrashFree,
        'eval_score_l0_skill_crash_free_invalid',
      ),
    },
    l1: {
      claimVerifiedRatio: boundedRatio(
        l1.claimVerifiedRatio,
        'eval_score_l1_claim_ratio_invalid',
      ),
      unsupportedClaims: nonnegativeInteger(
        l1.unsupportedClaims,
        'eval_score_l1_unsupported_claims_invalid',
      ),
      evidenceAnchors: nonnegativeInteger(
        l1.evidenceAnchors,
        'eval_score_l1_evidence_anchors_invalid',
      ),
    },
    ...(l2 ? {l2} : {}),
    l3: {
      turns: nonnegativeInteger(l3.turns, 'eval_score_l3_turns_invalid'),
      wallclockMs: nonnegativeInteger(
        l3.wallclockMs,
        'eval_score_l3_wallclock_invalid',
      ),
      ...(l3.estimatedTokens === undefined
        ? {}
        : {
            estimatedTokens: nonnegativeInteger(
              l3.estimatedTokens,
              'eval_score_l3_estimated_tokens_invalid',
            ),
          }),
      toolCalls: nonnegativeInteger(
        l3.toolCalls,
        'eval_score_l3_tool_calls_invalid',
      ),
    },
  } satisfies EvalScoreV1);
}

export function evalCaseContentHash(value: EvalCaseV1): string {
  return canonicalContentHash(parseEvalCase(value));
}

export function evalScoreContentHash(value: EvalScoreV1): string {
  return canonicalContentHash(parseEvalScore(value));
}

export function semanticEvalCaseFingerprint(value: EvalCaseV1): string {
  const evalCase = parseEvalCase(value);
  return canonicalContentHash({
    scope: evalCase.scope,
    traces: [...evalCase.traces].sort((left, right) =>
      left.role.localeCompare(right.role)),
    query: evalCase.query,
    analysisMode: evalCase.analysisMode,
    expectedScene: evalCase.expectedScene ?? null,
    label: evalCase.label ?? null,
    goldenPoints: evalCase.goldenPoints ?? null,
    expectedRubricVersion: evalCase.expectedRubricVersion ?? null,
    split: evalCase.split,
  });
}

export function evalPinnedFingerprint(value: EvalPinnedEnvironmentV1): string {
  return canonicalContentHash(parsePinned(value));
}

export function evalScoreKey(value: EvalScoreV1): string {
  const score = parseEvalScore(value);
  return canonicalContentHash({
    scope: score.scope,
    caseId: score.caseId,
    evalSetId: score.evalSetId,
    runId: score.runId,
    runManifestId: score.runManifestId,
    attempt: score.attempt,
    role: score.role,
    candidateId: score.candidateId ?? null,
  });
}

export const __testing = {
  parsePinned,
  parseScope,
};
