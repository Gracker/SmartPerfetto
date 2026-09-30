// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {getFinalReportContract, parseFinalReportContract} from '../../agentv3/strategyLoader';
import {
  analysisDeliveryFingerprint,
  reportRequirementsFingerprint,
  type AnalysisDeliveryContext,
  type AnalysisReportRequirement,
} from '../../types/analysisDelivery';
import {assessFinalReportContract, assessFinalReportContractCompleteness} from '../finalReportContractGate';

const conclusion = 'Current trace evidence is summarized here.';

/** A scrolling report whose one semantic review covered every requirement it was given. */
function context(requirements: readonly AnalysisReportRequirement[],
  caseBinding?: {caseRetrievalFingerprint: string}): Extract<AnalysisDeliveryContext, {entry: 'new_finalization'}> {
  const acceptedCandidate = {candidateRef: 'candidate-case', runId: 'run-case', attemptId: 'attempt-case',
    conclusionFingerprint: analysisDeliveryFingerprint(conclusion)};
  const turnIntent = {schemaVersion: 1 as const, status: 'resolved' as const, source: 'semantic' as const,
    registryFingerprint: 'registry-case', taskKind: 'investigation' as const, sceneId: 'scrolling',
    scope: 'scene_wide' as const, recommendedComplexity: 'full' as const,
    deliverable: 'report' as const, evidenceAccess: 'read_new' as const};
  const reportRequirements = {sceneId: 'scrolling', registryFingerprint: 'registry-case', requirements};
  return {entry: 'new_finalization', acceptedCandidate, turnIntent, reportRequirements,
    evidenceFingerprint: 'evidence-case',
    reportAssessment: {schemaVersion: 1, status: 'checked', binding: {...acceptedCandidate,
      registryFingerprint: 'registry-case', intentFingerprint: analysisDeliveryFingerprint(turnIntent),
      evidenceFingerprint: 'evidence-case', conclusionContractFingerprint: analysisDeliveryFingerprint(undefined),
      requirementsFingerprint: reportRequirementsFingerprint(reportRequirements), ...caseBinding,
    }, requirements: requirements.map(requirement => ({requirementId: requirement.id, applicability: 'applicable' as const,
      coverage: 'covered' as const, contentLocations: [{start: 0, end: conclusion.length}]}))}};
}

const scrollingRequirements = () => getFinalReportContract('scrolling')!.requiredSections;

describe('case recommendations never decide report completeness', () => {
  it('does not turn arbitrary result fields or query words into applicability proof', () => {
    const input = {conclusion, query: 'Find strong similar cases', sceneType: 'scrolling'};
    expect(assessFinalReportContract(input).status).toBe('not_checked');
    expect(assessFinalReportContractCompleteness(input)).toBeUndefined();
  });

  it('passes a covered scrolling report whether or not case retrieval ran', () => {
    // Retrieval runs after the answer, off by default and never in the CLI or a
    // conversation; a requirement bound to it left every scrolling report partial.
    const requirements = scrollingRequirements();
    expect(requirements.length).toBeGreaterThan(0);
    expect(assessFinalReportContract({conclusion, context: context(requirements)}).status).toBe('passed');
  });

  it('keeps a stale custom case-retrieval condition unresolved instead of requiring a citation', () => {
    const legacy = parseFinalReportContract({required_sections: [{id: 'case_recommendations',
      label: 'Similar cases', condition: {kind: 'strong_case_retrieval'}}]})!.requiredSections;
    const assessment = assessFinalReportContract({conclusion, context: context(legacy)});
    expect(assessment).toMatchObject({status: 'coverage_incomplete', missingSections: [],
      requirements: [{requirementId: 'case_recommendations', applicability: 'unknown', coverage: 'unknown'}]});
  });

  it('accepts an assessment bound before retrieval stopped deciding requirements', () => {
    const requirements = scrollingRequirements();
    const bound = context(requirements, {caseRetrievalFingerprint: analysisDeliveryFingerprint({status: 'not_checked'})});
    expect(assessFinalReportContract({conclusion, context: bound}).status).toBe('passed');
  });
});
