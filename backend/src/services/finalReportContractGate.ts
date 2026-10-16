// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AnalysisTurnIntent} from '../agentRuntime/analysisTurnIntent';
import type {SceneType} from '../agentv3/sceneClassifier';
import {
  analysisDeliveryFingerprint,
  reportRequirementsFingerprint,
  sameAnalysisCandidate,
  type AnalysisAssuranceStatus,
  type AnalysisDeliveryContext,
  type AnalysisReportRequirement,
  type AnalysisReportRequirementAssessment,
  type FinalReportAssessment,
} from '../types/analysisDelivery';

export interface FinalReportContractCompletenessInput {
  conclusion: string;
  conclusionContract?: unknown;
  context?: AnalysisDeliveryContext;
  /** Legacy arguments remain readable but do not select requirements or coverage. */
  query?: string;
  sceneType?: SceneType;
  contractSceneId?: string;
}

export interface FinalReportContractCompletenessResult {
  sceneType: SceneType;
  missingLabels: string[];
  missingSections: Array<{
    id: string;
    label: string;
    description?: string;
    /** Compatibility for old recovery callers; no synthetic section copy. */
    recoveryText: {zh: string[]; en: string[]};
  }>;
}

export interface FinalReportContractApplicabilityResult {
  sceneType: SceneType;
  requiredLabels: string[];
}

export interface FinalReportContractAssessmentResult {
  status: AnalysisAssuranceStatus;
  sceneType?: SceneType;
  requirements: AnalysisReportRequirementAssessment[];
  missingSections: AnalysisReportRequirement[];
  acceptedAssessment?: FinalReportAssessment;
}

/**
 * The applicability the server fixes before any review; `undefined` leaves it to
 * the semantic review. An unconditional requirement of a whole-scene report is
 * fixed applicable, so no review can waive it.
 */
export function fixedReportRequirementApplicability(
  requirement: AnalysisReportRequirement, scope: AnalysisTurnIntent['scope'],
): 'applicable' | 'unknown' | undefined {
  if (requirement.condition?.kind === 'unresolved') return 'unknown';
  return scope === 'scene_wide' && !requirement.condition ? 'applicable' : undefined;
}

/** Pure evaluation of a server-supplied, whole-body semantic assessment. */
export function assessFinalReportContract(
  input: FinalReportContractCompletenessInput,
): FinalReportContractAssessmentResult {
  const empty = (status: AnalysisAssuranceStatus): FinalReportContractAssessmentResult => ({
    status, requirements: [], missingSections: [],
  });
  const context = input.context;
  if (!context || context.entry === 'historical_restore') return empty('not_checked');
  const intent = context.turnIntent;
  if (!intent || intent.status !== 'resolved') return empty('not_checked');
  if (intent.deliverable === 'answer') return empty('not_applicable');
  const pin = context.reportRequirements;
  if (!pin || pin.sceneId !== intent.sceneId || pin.registryFingerprint !== intent.registryFingerprint) {
    return empty('not_checked');
  }
  const required = pin.requirements.filter(requirement => requirement.required !== false);
  if (required.length === 0) return {...empty('not_applicable'), sceneType: pin.sceneId};
  const declaredApplicability = (requirement: AnalysisReportRequirement) =>
    fixedReportRequirementApplicability(requirement, intent.scope) ?? 'unknown';
  const unknown = (status: AnalysisAssuranceStatus): FinalReportContractAssessmentResult => ({
    status,
    sceneType: pin.sceneId,
    requirements: required.map(requirement => ({
      requirementId: requirement.id, applicability: declaredApplicability(requirement), coverage: 'unknown',
    })),
    missingSections: [],
  });
  const assessment = context.reportAssessment;
  if (!assessment || assessment.schemaVersion !== 1 ||
    !['not_checked', 'unavailable', 'coverage_incomplete', 'checked'].includes(assessment.status) ||
    !sameAnalysisCandidate(assessment.binding, context.acceptedCandidate, input.conclusion) ||
    assessment.binding.registryFingerprint !== pin.registryFingerprint ||
    assessment.binding.intentFingerprint !== analysisDeliveryFingerprint(intent) ||
    assessment.binding.requirementsFingerprint !== reportRequirementsFingerprint(pin) ||
    assessment.binding.conclusionContractFingerprint !== analysisDeliveryFingerprint(input.conclusionContract) ||
    !context.evidenceFingerprint || assessment.binding.evidenceFingerprint !== context.evidenceFingerprint
  ) return unknown('not_checked');
  if (assessment.status === 'not_checked' || assessment.status === 'unavailable') {
    return {...unknown(assessment.status), acceptedAssessment: assessment};
  }

  const contract = input.conclusionContract as {claims?: Array<{id: string}>} | undefined;
  const claimIds = new Set(contract?.claims?.map(claim => claim.id) ?? []);
  const requirements = required.map(requirement => {
    const matching = assessment.requirements.filter(item => item.requirementId === requirement.id);
    const item = matching.length === 1 ? matching[0] : undefined;
    const declared = declaredApplicability(requirement);
    if (requirement.condition?.kind === 'unresolved') {
      return {requirementId: requirement.id, applicability: 'unknown' as const, coverage: 'unknown' as const};
    }
    if (!item || !['applicable', 'not_applicable', 'unknown'].includes(item.applicability) ||
      !['covered', 'missing', 'unknown'].includes(item.coverage)) {
      return {requirementId: requirement.id, applicability: declared, coverage: 'unknown' as const};
    }
    if (declared === 'applicable' && item.applicability !== 'applicable') {
      return {...item, applicability: declared, coverage: 'unknown' as const};
    }
    const hasValidLocation = Boolean(item.contentLocations?.length && item.contentLocations.every(location =>
      Number.isSafeInteger(location.start) && Number.isSafeInteger(location.end) &&
      location.start >= 0 && location.end > location.start && location.end <= input.conclusion.length));
    const hasValidClaims = Boolean(item.claimIds?.length && item.claimIds.every(id => claimIds.has(id)));
    if (item.coverage === 'covered' && !hasValidLocation && !hasValidClaims) {
      return {...item, coverage: 'unknown' as const};
    }
    return {...item};
  });
  const missingSections = required.filter(requirement => requirements.some(item =>
    item.requirementId === requirement.id && item.applicability === 'applicable' && item.coverage === 'missing'));
  const incomplete = assessment.status === 'coverage_incomplete' || requirements.some(item =>
    item.applicability === 'unknown' || (item.applicability === 'applicable' && item.coverage === 'unknown'));
  return {
    status: incomplete ? 'coverage_incomplete' : missingSections.length > 0 ? 'failed' :
      requirements.every(item => item.applicability === 'not_applicable') ? 'not_applicable' : 'passed',
    sceneType: pin.sceneId,
    requirements,
    missingSections,
    acceptedAssessment: assessment,
  };
}

/** Compatibility projection. Unknown applicability cannot invent required labels. */
export function assessFinalReportContractApplicability(
  input: FinalReportContractCompletenessInput,
): FinalReportContractApplicabilityResult | undefined {
  const assessment = assessFinalReportContract(input);
  const context = input.context;
  if (!assessment.sceneType || !context || context.entry === 'historical_restore') return undefined;
  const applicable = new Set(assessment.requirements.filter(item => item.applicability === 'applicable')
    .map(item => item.requirementId));
  const requiredLabels = context.reportRequirements?.requirements.filter(item => applicable.has(item.id))
    .map(item => item.label) ?? [];
  return requiredLabels.length ? {sceneType: assessment.sceneType, requiredLabels} : undefined;
}

/** Compatibility projection for callers migrating to typed recovery. */
export function assessFinalReportContractCompleteness(
  input: FinalReportContractCompletenessInput,
): FinalReportContractCompletenessResult | undefined {
  const assessment = assessFinalReportContract(input);
  if (!assessment.sceneType || assessment.missingSections.length === 0) return undefined;
  return {
    sceneType: assessment.sceneType,
    missingLabels: assessment.missingSections.map(section => section.label),
    missingSections: assessment.missingSections.map(section => ({
      ...section, recoveryText: {zh: [], en: []},
    })),
  };
}
