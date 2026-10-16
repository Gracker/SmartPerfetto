// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisResult} from '../../agent/core/orchestratorTypes';
import type {InvestigationEvidenceRecord} from '../evidence/investigationEvidenceLedger';
import type {InvestigationLedgerAcquisitionRow} from '../../types/analysisInvestigationAssessment';
import {INVESTIGATION_CONDITION_OPERATORS} from '../../types/analysisInvestigation';
import {isProductionAgentRuntimeKind} from '../../agentRuntime/runtimeKinds';
import {SOURCE_NEEDS} from '../../types/sourceNeed';
import {
  analysisDeliveryFingerprint,
  type AnalysisCandidateIdentity,
  type AnalysisAssuranceStatus,
  type AnalysisReportBinding,
} from '../../types/analysisDelivery';
import {projectKnowledgeUseForAudience, sanitizeKnowledgeUse} from '../knowledge/knowledgeUse';
import {
  sanitizeSourceClaimBindings,
  isLocateOnlyLookupKind,
  sanitizeSourceReference,
  sanitizeSourceUseDecision,
} from '../codebase/sourceUseDecision';

export type AnalysisDeliveryFields = Pick<AnalysisResult,
  'turnIntent' | 'completion' | 'outputOrigin' | 'runtimeAppendix' |
  'reportAssessment' | 'investigationAssessment' | 'deliveryAssurance' | 'knowledgeUse'>;

/** Preserve surviving field order because existing bindings hash the serialized contract. */
export function preserveProjectedFieldOrder<T>(original: unknown, projection: T, depth = 0): T {
  if (depth > 24 || !projection || typeof projection !== 'object') return projection;
  if (Array.isArray(projection)) return projection.map((value, index) =>
    preserveProjectedFieldOrder(Array.isArray(original) ? original[index] : undefined, value, depth + 1)) as T;
  const source = original && typeof original === 'object' && !Array.isArray(original)
    ? original as Record<string, unknown> : {};
  const target = projection as Record<string, unknown>;
  return Object.fromEntries([...new Set([...Object.keys(source), ...Object.keys(target)])]
    .filter(key => Object.prototype.hasOwnProperty.call(target, key))
    .map(key => [key, preserveProjectedFieldOrder(source[key], target[key], depth + 1)])) as T;
}

function member<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T);
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function contentLocation(value: unknown): value is {start: number; end: number} {
  return record(value) && typeof value.start === 'number' && typeof value.end === 'number' &&
    Number.isSafeInteger(value.start) && Number.isSafeInteger(value.end) && value.start >= 0 && value.end > value.start;
}

function opaqueId(value: unknown): string {
  return typeof value === 'string' && value.length <= 160 &&
    /^[A-Za-z0-9_.:-]+$/.test(value) ? value : '';
}

/** A text field projected for its audience, kept only when it is still an opaque identifier. */
function projectedId(value: unknown, projectText: (text: string) => string): string {
  return opaqueId(typeof value === 'string' ? projectText(value) : value);
}

function fingerprint(value: unknown): string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : '';
}

function exactNonnegativeInteger(value: unknown): value is number | string {
  return typeof value === 'number' ? Number.isSafeInteger(value) && value >= 0
    : typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) && value.length <= 20;
}

/** An explicit public row projection; no witness, owner key or nested producer data escapes. */
function copyInvestigationEvidenceRecords(values: readonly unknown[], projectText: (text: string) => string): InvestigationEvidenceRecord[] {
  return preserveProjectedFieldOrder(values, values.flatMap(raw => {
    if (!record(raw) || !record(raw.window) || !exactNonnegativeInteger(raw.window.start) ||
        !exactNonnegativeInteger(raw.window.end) || BigInt(raw.window.end) <= BigInt(raw.window.start) ||
        typeof raw.rowIndex !== 'number' || !Number.isSafeInteger(raw.rowIndex) || raw.rowIndex < 0 ||
        !member(raw.traceSide, ['current', 'reference']) ||
        !(raw.value === null || typeof raw.value === 'string' || typeof raw.value === 'boolean' ||
          (typeof raw.value === 'number' && Number.isFinite(raw.value)))) return [];
    const id = (value: unknown) => projectedId(value, projectText);
    const optionalId = (key: 'evidenceRefId' | 'artifactId' | 'sourceToolCallId' | 'originRunId') =>
      raw[key] === undefined ? {} : {[key]: id(raw[key])};
    const nullableIdentity = (key: 'cpu' | 'ucpu' | 'machineId') => raw[key] === null
      ? {[key]: null} : typeof raw[key] === 'number' && exactNonnegativeInteger(raw[key]) ? {[key]: raw[key]} : {};
    return [{recordId: id(raw.recordId), captureId: id(raw.captureId), rowIndex: raw.rowIndex,
      ...optionalId('evidenceRefId'), ...optionalId('artifactId'), ...optionalId('sourceToolCallId'), ...optionalId('originRunId'),
      skillId: id(raw.skillId), stepId: id(raw.stepId),
      definitionFingerprint: fingerprint(raw.definitionFingerprint), selectedSqlHash: fingerprint(raw.selectedSqlHash),
      traceId: id(raw.traceId), traceSide: raw.traceSide,
      origin: member(raw.origin, ['current_run', 'reused', 'unknown']) ? raw.origin : 'unknown',
      domain: id(raw.domain), metricId: id(raw.metricId),
      status: member(raw.status, ['observed', 'partial', 'unavailable', 'unknown']) ? raw.status : 'unknown',
      window: {start: raw.window.start, end: raw.window.end},
      ...(typeof raw.upid === 'number' && exactNonnegativeInteger(raw.upid) ? {upid: raw.upid} : {}),
      ...(typeof raw.utid === 'number' && exactNonnegativeInteger(raw.utid) ? {utid: raw.utid} : {}),
      ...nullableIdentity('cpu'), ...nullableIdentity('ucpu'), ...nullableIdentity('machineId'),
      ...(raw.windowId === null || (typeof raw.windowId === 'number' && exactNonnegativeInteger(raw.windowId))
        ? {windowId: raw.windowId} : typeof raw.windowId === 'string' ? {windowId: projectText(raw.windowId)} : {}),
      ...(raw.role === null ? {role: null} : typeof raw.role === 'string' ? {role: projectText(raw.role)} : {}),
      ...(typeof raw.aggregation === 'string' ? {aggregation: projectText(raw.aggregation)} : {}),
      value: typeof raw.value === 'string' ? projectText(raw.value) : raw.value,
      ...(typeof raw.unit === 'string' ? {unit: projectText(raw.unit)} : {}),
      ...(exactNonnegativeInteger(raw.coverage) ? {coverage: raw.coverage} : {}),
      ...(exactNonnegativeInteger(raw.denominator) ? {denominator: raw.denominator} : {}),
    }];
  }));
}

/** Exactly the row statuses the type allows; a status added there fails to compile here. */
const LEDGER_ACQUISITION_STATUSES = Object.keys({observed: true, partial: true, evidence_absent: true,
  not_applicable: true, not_declared: true, unknown: true,
} satisfies Record<InvestigationLedgerAcquisitionRow['status'], true>) as InvestigationLedgerAcquisitionRow['status'][];

/** An explicit public projection of the ledger-only acquisition rows. */
function copyLedgerAcquisitionRows(values: readonly unknown[], projectText: (text: string) => string): InvestigationLedgerAcquisitionRow[] {
  const id = (value: unknown) => projectedId(value, projectText);
  const metrics = (value: unknown) => Array.isArray(value) ? value.map(id).filter(Boolean) : [];
  const nullableFinite = (value: unknown): value is number | null =>
    value === null || (typeof value === 'number' && Number.isFinite(value));
  return preserveProjectedFieldOrder(values, values.flatMap(raw => {
    if (!record(raw) || !member(raw.applicability, ['applicable', 'not_applicable', 'unknown']) ||
        !member(raw.status, LEDGER_ACQUISITION_STATUSES)) return [];
    const condition = raw.condition;
    return [{requirementId: id(raw.requirementId), domain: id(raw.domain), applicability: raw.applicability,
      declaredMetrics: metrics(raw.declaredMetrics),
      ...(record(condition) && member(condition.operator, INVESTIGATION_CONDITION_OPERATORS) &&
        typeof condition.value === 'number' && Number.isFinite(condition.value) && nullableFinite(condition.observed) &&
        (condition.met === null || typeof condition.met === 'boolean')
        ? {condition: {metricId: id(condition.metricId), operator: condition.operator, value: condition.value,
          observed: condition.observed, met: condition.met}} : {}),
      status: raw.status, observedMetrics: metrics(raw.observedMetrics)}];
  }));
}

function candidate(value: AnalysisCandidateIdentity): AnalysisCandidateIdentity {
  return {
    candidateRef: opaqueId(value.candidateRef),
    runId: opaqueId(value.runId),
    attemptId: opaqueId(value.attemptId),
    conclusionFingerprint: fingerprint(value.conclusionFingerprint),
  };
}

function boundCandidate(value: AnalysisCandidateIdentity, conclusion: string): boolean {
  return Boolean(value.candidateRef && value.runId && value.attemptId &&
    value.conclusionFingerprint && value.conclusionFingerprint === analysisDeliveryFingerprint(conclusion));
}

function downgrade(status: AnalysisAssuranceStatus): AnalysisAssuranceStatus {
  return status === 'passed' || status === 'not_applicable' ? 'not_checked' : status;
}

function copyAssuranceStatus(value: unknown): AnalysisAssuranceStatus {
  return member(value, ['not_applicable', 'not_checked', 'unavailable', 'coverage_incomplete', 'passed', 'failed'])
    ? value : 'not_checked';
}

/**
 * `copyAnalysisDeliveryFields` copies every top-level investigation assessment
 * field. The projection treats any field it drops as tampering and withdraws
 * the whole assessment, so a field added to the type needs a copier here;
 * privateAnalysisProjection.test.ts fails to compile until its round-trip
 * fixture carries the new field.
 */
/** Explicit serialization only. These stored fields never issue current-run authority. */
export function copyAnalysisDeliveryFields(input: AnalysisDeliveryFields): AnalysisDeliveryFields {
  const output: AnalysisDeliveryFields = {};
  const intent = input.turnIntent;
  if (intent?.schemaVersion === 1 && member(intent.status, ['resolved', 'unavailable']) &&
      member(intent.source, ['semantic', 'fallback', 'product']) &&
      member(intent.taskKind, ['acknowledgement', 'fact', 'investigation', 'comparison']) &&
      member(intent.scope, ['bounded_question', 'scene_wide']) &&
      member(intent.recommendedComplexity, ['quick', 'full']) &&
      member(intent.deliverable, ['answer', 'report']) &&
      member(intent.evidenceAccess, ['existing_only', 'read_new'])) {
    output.turnIntent = {
      schemaVersion: 1, status: intent.status, source: intent.source,
      taskKind: intent.taskKind, sceneId: opaqueId(intent.sceneId), scope: intent.scope,
      recommendedComplexity: intent.recommendedComplexity, deliverable: intent.deliverable,
      evidenceAccess: intent.evidenceAccess, registryFingerprint: opaqueId(intent.registryFingerprint),
      ...(member(intent.sourceNeed, SOURCE_NEEDS) ? {sourceNeed: intent.sourceNeed} : {}),
      ...(typeof intent.reason === 'string' ? {reason: intent.reason} : {}),
      ...(typeof intent.actualModel === 'string' ? {actualModel: intent.actualModel} : {}),
      ...(typeof intent.finishReason === 'string' ? {finishReason: intent.finishReason} : {}),
      ...(member(intent.unavailableReason, ['timeout', 'provider_error', 'invalid_configuration',
        'invalid_response', 'tool_use', 'incomplete_output', 'output_limit', 'prompt_unavailable', 'context_limit'])
        ? {unavailableReason: intent.unavailableReason} : {}),
    };
  }
  const completion = input.completion;
  if (completion?.schemaVersion === 1 && isProductionAgentRuntimeKind(completion.runtimeKind) &&
      member(completion.status, ['completed', 'incomplete', 'failed', 'cancelled', 'unknown'])) {
    output.completion = {
      schemaVersion: 1, ...candidate(completion), runtimeKind: completion.runtimeKind,
      status: completion.status,
      ...(member(completion.reason, ['output_limit', 'turn_limit', 'timeout', 'budget_limit', 'provider_error', 'cancelled'])
        ? {reason: completion.reason} : {}),
      ...(typeof completion.sdkFinishReason === 'string' ? {sdkFinishReason: completion.sdkFinishReason} : {}),
    };
  }
  if (member(input.outputOrigin, ['sdk_final', 'assistant_stream', 'evidence_rendered', 'runtime_fallback'])) {
    output.outputOrigin = input.outputOrigin;
  }
  const appendix = input.runtimeAppendix;
  if (appendix?.schemaVersion === 1 && appendix.origin === 'runtime_fallback' && appendix.sourceCandidate &&
      typeof appendix.text === 'string') {
    output.runtimeAppendix = {
      schemaVersion: 1, origin: 'runtime_fallback', sourceCandidate: candidate(appendix.sourceCandidate),
      text: appendix.text,
      ...(member(appendix.reason, ['output_limit', 'turn_limit', 'timeout', 'budget_limit', 'provider_error', 'cancelled'])
        ? {reason: appendix.reason} : {}),
    };
  }
  const assessment = input.reportAssessment;
  if (assessment?.schemaVersion === 1 && assessment.binding && Array.isArray(assessment.requirements) &&
      member(assessment.status, ['not_checked', 'unavailable', 'coverage_incomplete', 'checked'])) {
    const binding = assessment.binding;
    output.reportAssessment = {
      schemaVersion: 1, status: assessment.status,
      binding: {
        ...candidate(binding),
        conclusionContractFingerprint: fingerprint(binding.conclusionContractFingerprint),
        evidenceFingerprint: fingerprint(binding.evidenceFingerprint),
        requirementsFingerprint: fingerprint(binding.requirementsFingerprint),
        registryFingerprint: opaqueId(binding.registryFingerprint),
        intentFingerprint: fingerprint(binding.intentFingerprint),
        ...(binding.caseRetrievalFingerprint !== undefined
          ? {caseRetrievalFingerprint: fingerprint(binding.caseRetrievalFingerprint)} : {}),
      },
      requirements: assessment.requirements.map((raw: unknown) => {
        const requirement = record(raw) ? raw : {};
        return {
          requirementId: opaqueId(requirement.requirementId),
          applicability: member(requirement.applicability, ['applicable', 'not_applicable', 'unknown'])
            ? requirement.applicability : 'unknown',
          coverage: member(requirement.coverage, ['covered', 'missing', 'unknown']) ? requirement.coverage : 'unknown',
          ...(Array.isArray(requirement.contentLocations) ? {contentLocations: requirement.contentLocations
            .filter(contentLocation).map(({start, end}) => ({start, end}))} : {}),
          ...(Array.isArray(requirement.claimIds) ? {claimIds: requirement.claimIds.map(opaqueId).filter(Boolean)} : {}),
        };
      }),
    };
  }
  const assurance = input.deliveryAssurance;
  if (assurance?.schemaVersion === 1 && member(assurance.entry, ['runtime_draft', 'new_finalization', 'historical_restore'])) {
    output.deliveryAssurance = {
      schemaVersion: 1, entry: assurance.entry,
      completion: copyAssuranceStatus(assurance.completion), claims: copyAssuranceStatus(assurance.claims),
      source: copyAssuranceStatus(assurance.source), identity: copyAssuranceStatus(assurance.identity),
      report: copyAssuranceStatus(assurance.report),
      ...(assurance.investigation !== undefined ? {investigation: copyAssuranceStatus(assurance.investigation)} : {}),
      ...(assurance.investigationEvidence !== undefined ? {investigationEvidence: copyAssuranceStatus(assurance.investigationEvidence)} : {}),
    };
  }
  const investigation = input.investigationAssessment;
  if (investigation?.schemaVersion === 1 && investigation.binding && Array.isArray(investigation.requirements) &&
      member(investigation.status, ['not_checked', 'unavailable', 'coverage_incomplete', 'checked'])) {
    const binding = investigation.binding;
    output.investigationAssessment = {
      schemaVersion: 1, status: investigation.status,
      ...(Array.isArray(investigation.evidenceRecords)
        ? {evidenceRecords: copyInvestigationEvidenceRecords(investigation.evidenceRecords, text => text)} : {}),
      ...(Array.isArray(investigation.ledgerAcquisition)
        ? {ledgerAcquisition: copyLedgerAcquisitionRows(investigation.ledgerAcquisition, text => text)} : {}),
      binding: {...candidate(binding),
        conclusionContractFingerprint: fingerprint(binding.conclusionContractFingerprint),
        evidenceFingerprint: fingerprint(binding.evidenceFingerprint),
        requirementsFingerprint: fingerprint(binding.requirementsFingerprint),
        registryFingerprint: opaqueId(binding.registryFingerprint),
        intentFingerprint: fingerprint(binding.intentFingerprint),
        ledgerFingerprint: fingerprint(binding.ledgerFingerprint),
        ...(binding.evidenceRecordsFingerprint !== undefined
          ? {evidenceRecordsFingerprint: fingerprint(binding.evidenceRecordsFingerprint)} : {}),
        ...(binding.caseRetrievalFingerprint !== undefined
          ? {caseRetrievalFingerprint: fingerprint(binding.caseRetrievalFingerprint)} : {})},
      requirements: investigation.requirements.map((raw: unknown) => {
        const requirement = record(raw) ? raw : {};
        const acquisitionStatuses = ['observed', 'insufficient', 'not_checked', 'failed', 'not_applicable', 'unknown'] as const;
        return {
          requirementId: opaqueId(requirement.requirementId), domain: opaqueId(requirement.domain),
          applicability: member(requirement.applicability, ['applicable', 'not_applicable', 'unknown'])
            ? requirement.applicability : 'unknown',
          coverage: member(requirement.coverage, ['covered', 'missing', 'unknown']) ? requirement.coverage : 'unknown',
          scopeMatch: member(requirement.scopeMatch, ['matched', 'mismatched', 'unknown']) ? requirement.scopeMatch : 'unknown',
          acquisition: member(requirement.acquisition, acquisitionStatuses) ? requirement.acquisition : 'unknown',
          evidenceStatus: member(requirement.evidenceStatus, acquisitionStatuses) ? requirement.evidenceStatus : 'unknown',
          contentLocations: Array.isArray(requirement.contentLocations)
            ? requirement.contentLocations.filter(contentLocation).map(({start, end}) => ({start, end})) : [],
          evidenceRecordIds: Array.isArray(requirement.evidenceRecordIds)
            ? requirement.evidenceRecordIds.map(opaqueId).filter(Boolean) : [],
        };
      }),
    };
  }
  // A display and audit record, copied only in its closed shape; it binds nothing.
  const knowledgeUse = sanitizeKnowledgeUse(input.knowledgeUse);
  if (knowledgeUse) output.knowledgeUse = knowledgeUse;
  return preserveProjectedFieldOrder(input, output);
}

/**
 * Kept diagnostics are provider text: project them in place, so an unchanged
 * value keeps its field order and the binding computed over it.
 */
function projectTextFields<T extends object>(value: T, keys: readonly (keyof T)[],
  projectText: (text: string) => string): T {
  const projected = {...value};
  for (const key of keys) {
    const entry = projected[key];
    if (typeof entry === 'string') projected[key] = projectText(entry) as T[keyof T];
  }
  return projected;
}

export function analysisProjectionChanged(before: unknown, after: unknown): boolean {
  return analysisDeliveryFingerprint(before) !== analysisDeliveryFingerprint(after);
}

/**
 * Redaction invalidates a binding; it cannot re-sign a different body. Empty
 * fingerprints deliberately represent no binding and remain empty on replay.
 */
export function projectPrivateAnalysisDelivery(
  input: AnalysisDeliveryFields & {conclusion?: string; conclusionContract?: unknown},
  projection: {conclusion: string; conclusionContract?: unknown; claimsChanged?: boolean;
    sourceChanged?: boolean; identityChanged?: boolean; evidenceChanged?: boolean},
  projectText: (text: string) => string,
  options: {privateMetadata?: boolean} = {},
): AnalysisDeliveryFields {
  const output = copyAnalysisDeliveryFields(input);
  const bodyChanged = input.conclusion !== projection.conclusion;
  const contractChanged = analysisProjectionChanged(input.conclusionContract, projection.conclusionContract);
  const claimsChanged = bodyChanged || contractChanged || Boolean(projection.claimsChanged);
  if (output.turnIntent) {
    const {reason: _reason, actualModel: _model, finishReason: _finish, ...intent} = output.turnIntent;
    output.turnIntent = options.privateMetadata !== false ? intent
      : projectTextFields(output.turnIntent, ['reason', 'actualModel', 'finishReason'], projectText);
  }
  const intentChanged = analysisProjectionChanged(input.turnIntent, output.turnIntent);
  if (output.completion) {
    const {sdkFinishReason: _finishReason, ...safeCompletion} = output.completion;
    const completion = options.privateMetadata === false
      ? projectTextFields(output.completion, ['sdkFinishReason'], projectText) : safeCompletion;
    const bound = !bodyChanged && boundCandidate(completion, projection.conclusion);
    output.completion = {...completion,
      ...(!bound ? {conclusionFingerprint: '',
        status: completion.status === 'completed' ? 'unknown' as const : completion.status} : {})};
  }
  if (output.runtimeAppendix) {
    const appendix = output.runtimeAppendix;
    output.runtimeAppendix = {...appendix, text: projectText(appendix.text),
      sourceCandidate: {...appendix.sourceCandidate,
        ...(!boundCandidate(appendix.sourceCandidate, projection.conclusion) || bodyChanged
          ? {conclusionFingerprint: ''} : {})}};
  }
  if (output.knowledgeUse) {
    // Already in its closed shape (the copy above). The owner keeps the
    // citations of their answer; other audiences keep the sources only.
    output.knowledgeUse = projectKnowledgeUseForAudience(output.knowledgeUse,
      {owner: options.privateMetadata === false, projectText});
  }
  if (output.investigationAssessment) {
    output.investigationAssessment = {...output.investigationAssessment,
      ...(output.investigationAssessment.evidenceRecords ? {evidenceRecords:
        copyInvestigationEvidenceRecords(output.investigationAssessment.evidenceRecords, projectText)} : {}),
      ...(output.investigationAssessment.ledgerAcquisition ? {ledgerAcquisition:
        copyLedgerAcquisitionRows(output.investigationAssessment.ledgerAcquisition, projectText)} : {}),
      requirements: output.investigationAssessment.requirements.map(requirement => ({...requirement,
        requirementId: opaqueId(projectText(requirement.requirementId)),
        domain: opaqueId(projectText(requirement.domain)),
        evidenceRecordIds: requirement.evidenceRecordIds.map(id => opaqueId(projectText(id))).filter(Boolean)}))};
  }
  const assessment = output.reportAssessment;
  const reportInvalid = analysisProjectionChanged(input.reportAssessment, assessment) || Boolean(assessment && (claimsChanged || intentChanged || projection.sourceChanged ||
    !boundCandidate(assessment.binding, projection.conclusion) ||
    assessment.binding.conclusionContractFingerprint !== analysisDeliveryFingerprint(projection.conclusionContract) ||
    assessment.binding.intentFingerprint !== analysisDeliveryFingerprint(output.turnIntent) ||
    Object.values(assessment.binding).some(value => value === '') ||
    assessment.requirements.some(requirement => requirement.contentLocations?.some(location => location.end > projection.conclusion.length))));
  if (assessment && reportInvalid) {
    const binding: AnalysisReportBinding = {...assessment.binding,
      conclusionFingerprint: '', conclusionContractFingerprint: '', evidenceFingerprint: '', intentFingerprint: ''};
    output.reportAssessment = {...assessment, binding,
      status: assessment.status === 'checked' ? 'coverage_incomplete' : assessment.status,
      requirements: assessment.requirements.map(requirement => ({
        requirementId: requirement.requirementId,
        applicability: requirement.applicability === 'not_applicable' ? 'unknown' : requirement.applicability,
        coverage: requirement.coverage === 'covered' ? 'unknown' : requirement.coverage,
      }))};
  }
  const investigation = output.investigationAssessment;
  const investigationContextChanged = claimsChanged || intentChanged || projection.sourceChanged ||
    projection.identityChanged || projection.evidenceChanged;
  const investigationInvalid = analysisProjectionChanged(input.investigationAssessment, investigation) ||
    Boolean(investigation && (investigationContextChanged || !boundCandidate(investigation.binding, projection.conclusion) ||
      investigation.binding.conclusionContractFingerprint !== analysisDeliveryFingerprint(projection.conclusionContract) ||
      investigation.binding.intentFingerprint !== analysisDeliveryFingerprint(output.turnIntent) ||
      (investigation.evidenceRecords !== undefined && investigation.binding.evidenceRecordsFingerprint !==
        analysisDeliveryFingerprint(investigation.evidenceRecords)) ||
      Object.values(investigation.binding).some(value => value === '') ||
      investigation.requirements.some(requirement => requirement.contentLocations.some(location => location.end > projection.conclusion.length))));
  if (investigation && investigationInvalid) {
    output.investigationAssessment = {...investigation,
      status: investigation.status === 'checked' ? 'coverage_incomplete' : investigation.status,
      ...(investigation.evidenceRecords ? {evidenceRecords: investigation.evidenceRecords.map(row => ({...row,
        status: 'unknown' as const, origin: 'unknown' as const}))} : {}),
      ...(investigation.ledgerAcquisition ? {ledgerAcquisition: investigation.ledgerAcquisition.map(row => ({...row,
        applicability: row.applicability === 'not_applicable' ? 'unknown' as const : row.applicability,
        status: 'unknown' as const, observedMetrics: []}))} : {}),
      binding: {...investigation.binding, conclusionFingerprint: '', conclusionContractFingerprint: '',
        evidenceFingerprint: '', intentFingerprint: '', ledgerFingerprint: '',
        ...(investigation.evidenceRecords !== undefined || investigation.binding.evidenceRecordsFingerprint !== undefined
          ? {evidenceRecordsFingerprint: ''} : {})},
      requirements: investigation.requirements.map(requirement => ({...requirement,
        applicability: requirement.applicability === 'not_applicable' ? 'unknown' : requirement.applicability,
        coverage: requirement.coverage === 'covered' ? 'unknown' : requirement.coverage,
        acquisition: 'unknown', evidenceStatus: 'unknown', scopeMatch: 'unknown', contentLocations: [], evidenceRecordIds: []}))};
  }
  if (output.deliveryAssurance) {
    const assurance = output.deliveryAssurance;
    output.deliveryAssurance = {...assurance,
      completion: bodyChanged || !output.completion || !boundCandidate(output.completion, projection.conclusion)
        ? downgrade(assurance.completion) : assurance.completion,
      claims: claimsChanged ? downgrade(assurance.claims) : assurance.claims,
      source: claimsChanged || projection.sourceChanged ? downgrade(assurance.source) : assurance.source,
      identity: projection.identityChanged ? downgrade(assurance.identity) : assurance.identity,
      report: reportInvalid || claimsChanged || intentChanged ? downgrade(assurance.report) : assurance.report,
      ...(assurance.investigation !== undefined ? {investigation: investigationInvalid || investigationContextChanged ||
        (!investigation && assurance.investigation !== 'not_applicable')
        ? downgrade(assurance.investigation) : assurance.investigation} : {}),
      ...(assurance.investigationEvidence !== undefined ? {investigationEvidence: investigationInvalid || investigationContextChanged ||
        (!investigation && assurance.investigationEvidence !== 'not_applicable')
        ? downgrade(assurance.investigationEvidence) : assurance.investigationEvidence} : {})};
  }
  return output;
}

/** Legacy source metadata is copied safely, without claim verification or prose rewriting. */
export function projectStoredConclusionSourceMetadata<T>(contract: T, actualDecision?: unknown): T {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) return contract;
  const record = contract as Record<string, unknown>;
  if (!['sourceUseDecision', 'sourceReferences', 'sourceClaimBindings'].some(key => key in record)) return contract;
  const decision = sanitizeSourceUseDecision(actualDecision ?? record.sourceUseDecision);
  const {sourceUseDecision: _decision, sourceReferences: _refs, sourceClaimBindings: _bindings, ...rest} = record;
  if (!decision) return rest as T;
  const references = decision.references.filter(reference => decision.codeAwareMode !== 'metadata_only' ||
    isLocateOnlyLookupKind(reference.lookupKind));
  const allowed = new Set(references.map(reference => reference.id));
  // A declared id the run issued stays as it is; only an older declaration
  // whose id the ledger does not know maps to its recomputed identity.
  const aliases = new Map<string, string>();
  for (const reference of Array.isArray(record.sourceReferences) ? record.sourceReferences : []) {
    const safe = sanitizeSourceReference(reference);
    if (safe && reference && typeof reference === 'object' && typeof reference.id === 'string' &&
      !allowed.has(reference.id)) {
      aliases.set(reference.id, safe.id);
    }
  }
  const bindings = sanitizeSourceClaimBindings(record.sourceClaimBindings, {referenceIdAliases: aliases})
    .filter(binding => binding.sourceReferenceIds.every(id => allowed.has(id)));
  // Keep absent optional declarations absent so storage alone cannot change a signed contract.
  return preserveProjectedFieldOrder(contract, {...rest, sourceUseDecision: {...decision, references}, sourceReferences: references,
    ...(Object.prototype.hasOwnProperty.call(record, 'sourceClaimBindings') && record.sourceClaimBindings !== undefined
      ? {sourceClaimBindings: bindings} : {})} as T);
}
