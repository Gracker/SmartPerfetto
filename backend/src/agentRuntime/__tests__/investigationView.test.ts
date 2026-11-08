// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {createInvestigationViewSource} from '../investigation/investigationView';
import {decideInvestigationTurn} from '../investigation/investigationTurnDecision';
import {projectInvestigationReceipt} from '../investigation/investigationReceipt';
import type {AnalysisTurnIntent} from '../analysisTurnIntent';
import {buildStrategyRegistrySnapshotFromDefinitions, getRegisteredScenes} from '../../agentv3/strategyLoader';
import type {AnalysisInvestigationContract} from '../../types/analysisInvestigation';
import type {InvestigationEvidenceSnapshot} from '../../services/evidence/investigationEvidenceLedger';

const contract: AnalysisInvestigationContract = {schemaVersion: 1, profileRefs: [], requirements: [
  {id: 'acquired', domain: 'cpu', description: 'Acquired metric', required: true, evidenceMetrics: ['metric.a']},
  {id: 'not_yet', domain: 'cpu', description: 'Declared, only partially captured', required: true, evidenceMetrics: ['metric.b']},
  {id: 'no_producer', domain: 'gpu', description: 'No declared producer', required: false},
  {id: 'gated_out', domain: 'io', description: 'Contract evidence condition is false', required: true,
    evidenceMetrics: ['metric.c'], condition: {kind: 'evidence', description: 'Only when the gate is high',
      metricId: 'metric.gate', operator: 'gt', value: 10}},
  {id: 'semantic', domain: 'cpu', description: 'Semantic applicability, acquired metric', required: false,
    evidenceMetrics: ['metric.a'], condition: {kind: 'semantic', description: 'Model judgement only'}},
]};

function registryWith(investigationContract: AnalysisInvestigationContract) {
  const startup = getRegisteredScenes().find(definition => definition.scene === 'startup')!;
  return buildStrategyRegistrySnapshotFromDefinitions({definitions: [{...startup, investigationContract}], overlayGeneration: 'test'});
}

function intent(registryFingerprint: string, overrides: Partial<AnalysisTurnIntent> = {}): AnalysisTurnIntent {
  return {schemaVersion: 1, status: 'resolved', source: 'semantic', taskKind: 'investigation', sceneId: 'startup',
    scope: 'scene_wide', recommendedComplexity: 'full', deliverable: 'report', evidenceAccess: 'read_new',
    registryFingerprint, ...overrides};
}

// The view reads only the issued snapshot's records and issues.
const ledger = (records: Array<{metricId: string; status: string; value: number}>) =>
  ({schemaVersion: 'investigation_evidence@1', ownerKey: 'owner', currentRunId: 'run-1', fingerprint: 'f',
    records, issues: [], complete: true} as unknown as InvestigationEvidenceSnapshot);

const budget = {providerTurnsUsed: 2, providerTurnLimit: 8, totalTurnLimit: 10, startedAtMs: 1_000, deadlineMs: 61_000};

function source(input: {registry?: ReturnType<typeof registryWith>; readEvidence?: () => InvestigationEvidenceSnapshot | undefined;
  intent?: Partial<AnalysisTurnIntent>} = {}) {
  const registry = input.registry ?? registryWith(contract);
  return createInvestigationViewSource({runId: 'run-1', intent: intent(registry.registryFingerprint, input.intent),
    strategyRegistry: registry, readEvidence: input.readEvidence ?? (() => undefined), readBudget: () => budget, now: () => 11_000});
}

describe('investigation view', () => {
  it('classifies each requirement into exactly one producer-derived status', () => {
    const view = source({readEvidence: () => ledger([
      {metricId: 'metric.a', status: 'observed', value: 1},
      {metricId: 'metric.b', status: 'partial', value: 2},
      {metricId: 'metric.gate', status: 'observed', value: 5},
    ])}).derive(1);
    expect(view.requirements.items).toEqual([
      {id: 'acquired', required: true, status: 'observed'},
      {id: 'not_yet', required: true, status: 'not_observed'},
      {id: 'no_producer', required: false, status: 'unknown_no_producer'},
      {id: 'gated_out', required: true, status: 'not_applicable'},
      {id: 'semantic', required: false, status: 'observed'},
    ]);
    expect(view.requirements).toMatchObject({contract: 'resolved', omittedCount: 0,
      counts: {observed: 2, notObserved: 1, unknownNoProducer: 1, notApplicable: 1}});
    expect(view.evidence).toEqual({status: 'read', recordCount: 3, complete: true});
    expect(view.target).toEqual({status: 'resolved', sceneId: 'startup', scope: 'scene_wide', deliverable: 'report',
      evidenceAccess: 'read_new', taskKind: 'investigation'});
    expect(view.budget).toEqual({providerTurnsUsed: 2, providerTurnLimit: 8, totalTurnLimit: 10, elapsedMs: 10_000, remainingMs: 50_000});
  });

  it('keeps an unobserved evidence gate and an unreadable ledger short of not_applicable or observed', () => {
    const unread = source({readEvidence: () => {throw new Error('PRIVATE_LEDGER_FAILURE');}}).derive(1);
    expect(unread.evidence).toEqual({status: 'failed', recordCount: 0, complete: false});
    expect(unread.requirements.items.map(item => item.status))
      .toEqual(['not_observed', 'not_observed', 'unknown_no_producer', 'not_observed', 'not_observed']);
    expect(JSON.stringify(unread)).not.toContain('PRIVATE_LEDGER_FAILURE');
    expect(source().derive(1).evidence.status).toBe('unavailable');
  });

  it('reports a not_applicable contract as a whole, never per requirement', () => {
    const exempt = source({registry: registryWith({...contract, notApplicableReason: 'contract_declares_exempt'})}).derive(1);
    expect(exempt.requirements).toEqual({contract: 'not_applicable', reason: 'contract_declares_exempt', items: [],
      omittedCount: 0, counts: {observed: 0, notObserved: 0, unknownNoProducer: 0, notApplicable: 0}});
    expect(source({intent: {taskKind: 'fact'}}).derive(1).requirements).toMatchObject({contract: 'not_applicable', reason: 'task_kind_exempt'});
    expect(source({intent: {registryFingerprint: 'stale'}}).derive(1).requirements)
      .toMatchObject({contract: 'not_checked', reason: 'registry_fingerprint_mismatch', items: []});
  });

  it('reads acquisition behind an undecided condition, but never takes an unobserved gate as not_applicable', () => {
    const gated = (metric: string) => ({id: `gate_${metric}`, domain: 'io', description: 'Gate not yet observed', required: true,
      evidenceMetrics: [metric], condition: {kind: 'evidence' as const, description: 'Only when the gate is high',
        metricId: 'metric.gate', operator: 'gt' as const, value: 10}});
    const registry = registryWith({...contract, requirements: [gated('metric.a'), gated('metric.b'), contract.requirements[2]]});
    const view = source({registry, readEvidence: () => ledger([{metricId: 'metric.a', status: 'observed', value: 1}])}).derive(1);
    expect(view.requirements.items.map(item => item.status)).toEqual(['observed', 'not_observed', 'unknown_no_producer']);
  });

  it('derives deterministically, and its receipt names the decision it was given', () => {
    const viewSource = source();
    const view = viewSource.derive(3);
    expect(view).toEqual(viewSource.derive(3));
    expect(view).toMatchObject({schemaVersion: 'investigation_view@1', runId: 'run-1', attempt: 3});
    const decision = decideInvestigationTurn(view);
    expect(decision).toEqual({schemaVersion: 'investigation_turn_decision@1', tools: {kind: 'unchanged'},
      progressMessages: [], foldPlan: {kind: 'none'}, executionPurpose: {kind: 'unchanged'}});
    expect(projectInvestigationReceipt(view, decision)).toEqual({
      requirements: {contract: 'resolved', observed: 0, notObserved: 4, unknownNoProducer: 1, notApplicable: 0},
      evidence: 'unavailable', turns: {used: 2, limit: 8, total: 10}, elapsedMs: 10_000, remainingMs: 50_000, decision: 'no_change'});
    // A decision the receipt cannot name is never recorded as no change.
    expect(() => projectInvestigationReceipt(view, {...decision, progressMessages: [{}] as never[]}))
      .toThrow('investigation_decision_unrecordable');
  });
});
