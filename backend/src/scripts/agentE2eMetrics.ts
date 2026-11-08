// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)

import {createHash} from 'node:crypto';
import {MODEL_REQUEST_COMPONENTS, RUNTIME_MODEL_CALL_PURPOSES, RUNTIME_MODEL_CALL_TRIGGERS,
  RUNTIME_MODEL_REASONING_EFFORTS, RUNTIME_DECLARATION_AUTHORING_STATUSES, RUNTIME_DECLARATION_AUTHORING_VERSIONS,
  projectRuntimeModelPolicyReceipt, projectRuntimeFinalTransportObservation} from '../agentRuntime/runtimePerformance';
import {getFinalSubmissionModeDescriptor, type FinalSubmissionModeKey} from '../agentRuntime/finalSubmissionImplementation';
import {RECORDED_PRODUCTION_RUNTIME_KINDS} from '../agentRuntime/runtimeKinds';
import {getRunManifestStore} from '../services/selfEvolution/runManifestStore';
import type {RunManifestScope, RunManifestV1} from '../types/selfEvolution';

const PHASES = ['classification', 'quick_evidence', 'focus', 'architecture', 'completeness',
  'comparison', 'skill_registry', 'knowledge', 'scene_evidence', 'sdk_start', 'provider',
  'verification', 'correction', 'finalization'] as const;
const OUTCOMES = ['ok', 'error', 'cancelled'] as const;
const MAX_ITEMS = 512;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('metrics_object_invalid');
  return value as Record<string, unknown>;
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('metrics_number_invalid');
  return value;
}

function member<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new Error('metrics_enum_invalid');
  return value as T;
}

function finalSubmissionMode(value: unknown): FinalSubmissionModeKey {
  if (!getFinalSubmissionModeDescriptor(value)) throw new Error('metrics_enum_invalid');
  return value as FinalSubmissionModeKey;
}

function numbers(value: unknown, keys: readonly string[]): Record<string, number> {
  const source = record(value);
  return Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, number(source[key])]));
}

function rows(value: unknown, project: (row: Record<string, unknown>) => unknown): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_ITEMS) throw new Error('metrics_array_invalid');
  return value.map(value => project(record(value)));
}

function optionalHash(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    ? createHash('sha256').update(value).digest('hex') : undefined;
}

function modelSource(row: Record<string, unknown>) {
  if (row.modelSource === undefined) return {};
  const source = member(row.modelSource, ['configured', 'provider_reported']);
  if (typeof row.model !== 'string' || !row.model || row.model.trim() !== row.model || row.model.length > 128 ||
      /[\u0000-\u001f\u007f]/.test(row.model)) throw new Error('metrics_model_source_invalid');
  return {modelSource: source};
}

function modelOutput(value: unknown) {
  const source = record(value);
  if (source.declarationAuthoringVersion !== undefined && source.declarationAuthoringStatus !== 'expanded') {
    throw new Error('metrics_authoring_version_without_expansion');
  }
  return {...numbers(source, ['bodyChars', 'sidecarChars']),
    ...(source.declarationAuthoringStatus === undefined ? {} : {
      declarationAuthoringStatus: member(source.declarationAuthoringStatus, RUNTIME_DECLARATION_AUTHORING_STATUSES),
    }), ...(source.declarationAuthoringVersion === undefined ? {} : {
      declarationAuthoringVersion: member(source.declarationAuthoringVersion, RUNTIME_DECLARATION_AUTHORING_VERSIONS),
    })};
}

/** Metrics-only projection: never export arbitrary manifest fields or nested native payloads. */
export function projectAgentE2ePerformance(value: unknown) {
  const source = record(value);
  if (source.schemaVersion !== 1) throw new Error('metrics_version_invalid');
  const finalTransportObservation = source.finalTransportObservation === undefined ? undefined
    : projectRuntimeFinalTransportObservation(source.finalTransportObservation);
  if (source.finalTransportObservation !== undefined && !finalTransportObservation) throw new Error('metrics_final_transport_invalid');
  return {
    schemaVersion: 1,
    ...numbers(source, ['firstOutputMs']),
    phases: rows(source.phases, row => ({
      name: member(row.name, PHASES), outcome: member(row.outcome, OUTCOMES),
      ...numbers(row, ['startOffsetMs', 'durationMs']),
    })),
    tools: rows(source.tools, row => ({
      mode: member(row.mode, ['exclusive', 'commutative_read']), outcome: member(row.outcome, OUTCOMES),
      ...numbers(row, ['schedulerWaitMs', 'durationMs']),
    })),
    sql: rows(source.sql, row => ({
      priority: member(row.priority, ['p0', 'p1', 'p2']), outcome: member(row.outcome, OUTCOMES),
      ...numbers(row, ['queueWaitMs', 'executionMs']),
    })),
    ...(source.modelCalls === undefined ? {} : {modelCalls: rows(source.modelCalls, row => ({
      purpose: member(row.purpose, RUNTIME_MODEL_CALL_PURPOSES), outcome: member(row.outcome, OUTCOMES),
      ...(row.trigger === undefined ? {} : {trigger: member(row.trigger, RUNTIME_MODEL_CALL_TRIGGERS)}),
      modelHash: optionalHash(row.model), ...modelSource(row), providerOriginHash: optionalHash(row.providerOrigin),
      ...numbers(row, ['startOffsetMs', 'durationMs', 'firstOutputMs']),
      ...(row.reasoning === undefined ? {} : {reasoning: member(row.reasoning, ['provider_default', 'disabled', 'enabled'])}),
      ...(row.reasoningEffort === undefined ? {} : {reasoningEffort: member(row.reasoningEffort, RUNTIME_MODEL_REASONING_EFFORTS)}),
      ...(row.output === undefined ? {} : {output: modelOutput(row.output)}),
      ...(row.usage === undefined ? {} : {usage: numbers(row.usage,
        ['inputTokens', 'outputTokens', 'reasoningTokens', 'cachedInputTokens'])}),
    }))}),
    ...(source.modelRequests === undefined ? {} : {modelRequests: rows(source.modelRequests, row => {
      const body = record(row.body);
      const normalized = body.normalized === undefined ? undefined : record(body.normalized);
      return {
        ...numbers(row, ['dispatchOrdinal', 'startOffsetMs', 'headersMs', 'httpStatus']),
        fetchOutcome: member(row.fetchOutcome, ['pending', 'headers', 'error', 'cancelled']),
        ...(row.purpose === undefined ? {} : {purpose: member(row.purpose, RUNTIME_MODEL_CALL_PURPOSES)}),
        ...(row.trigger === undefined ? {} : {trigger: member(row.trigger, RUNTIME_MODEL_CALL_TRIGGERS)}),
        body: {
          status: member(body.status, ['observed', 'body_unobservable']), ...numbers(body, ['bodyBytes']),
          ...(body.normalizedUnavailableReason === undefined ? {} : {
            normalizedUnavailableReason: member(body.normalizedUnavailableReason, ['non_json', 'too_large', 'unsupported_shape']),
          }),
          ...(normalized ? {normalized: {
            measurement: member(normalized.measurement, ['normalized_json_utf8']),
            totalBytes: number(normalized.totalBytes), components: numbers(normalized.components, MODEL_REQUEST_COMPONENTS),
          }} : {}),
        },
      };
    })}),
    ...(finalTransportObservation ? {finalTransportObservation} : {}),
    ...(source.policyObservations === undefined ? {} : {policyObservations: rows(source.policyObservations, row => {
      const receipt = projectRuntimeModelPolicyReceipt(row);
      if (!receipt || !Number.isSafeInteger(row.observationOrdinal) || (row.observationOrdinal as number) < 1
          || (row.observationOrdinal as number) > MAX_ITEMS) throw new Error('metrics_policy_observation_invalid');
      return {...receipt, observationOrdinal: row.observationOrdinal as number,
        observedOffsetMs: number(row.observedOffsetMs)};
    })}),
    ...(source.truncated === undefined ? {} : {truncated: numbers(source.truncated,
      ['phases', 'tools', 'sql', 'modelCalls', 'modelRequests', 'policyObservations'])}),
  };
}

/** Same-process read covers ephemeral/private runs without adding an HTTP or SSE surface. */
export function readAgentE2eMetrics(input: {scope: RunManifestScope; sessionId: string; runId: string},
  read: (scope: RunManifestScope, runId: string) => RunManifestV1 | undefined =
    (scope, runId) => getRunManifestStore().getByRunId(scope, runId)) {
  const schemaVersion = 'llm_execution_metrics_artifact@1' as const;
  try {
    if (!input.sessionId || !input.runId) return {schemaVersion, status: 'unavailable' as const};
    const manifest = read(input.scope, input.runId);
    if (!manifest) return {schemaVersion, status: 'unavailable' as const};
    if (manifest.runId !== input.runId || manifest.sessionId !== input.sessionId ||
        manifest.scope.tenantId !== input.scope.tenantId || manifest.scope.workspaceId !== input.scope.workspaceId) {
      return {schemaVersion, status: 'identity_mismatch' as const};
    }
    return {schemaVersion, status: 'sealed' as const, runId: input.runId, sessionId: input.sessionId,
      sealedAt: number(manifest.sealedAt), wallclockMs: number(manifest.wallclockMs),
      runtime: member(manifest.runtime, RECORDED_PRODUCTION_RUNTIME_KINDS), modelHash: optionalHash(manifest.model),
      ...(manifest.conclusionDeclarationSyntax === undefined ? {} : {
        conclusionDeclarationSyntax: member(manifest.conclusionDeclarationSyntax, ['canonical_v1', 'authoring_v1', 'authoring_v2']),
      }),
      // Declaration syntax is retired; only a historical manifest still records it.
      ...(manifest.finalSubmission === undefined ? {} : {requestedOutputConfig: {
        finalSubmission: finalSubmissionMode(manifest.finalSubmission),
        ...(manifest.conclusionDeclarationSyntax === undefined ? {} : {declarationSyntax:
          member(manifest.conclusionDeclarationSyntax, ['canonical_v1', 'authoring_v1', 'authoring_v2'])}),
      }}),
      providerSnapshotHash: typeof manifest.providerSnapshotHash === 'string' &&
        /^(?:sha256:)?[a-f0-9]{64}$/.test(manifest.providerSnapshotHash) ? manifest.providerSnapshotHash : undefined,
      performance: projectAgentE2ePerformance(manifest.performance)};
  } catch {
    // Observability must not fail an otherwise valid analysis or quote stored data.
    return {schemaVersion, status: 'invalid_receipt' as const};
  }
}
