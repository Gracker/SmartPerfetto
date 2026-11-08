// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {createInvestigationViewSource} from '../investigation/investigationView';
import {
  decideInvestigationTurn,
  type InvestigationProgressRequirementV1,
  type InvestigationTurnInput,
} from '../investigation/investigationTurnDecision';
import {projectInvestigationReceipt} from '../investigation/investigationReceipt';
import {
  buildInvestigationProgressCatalog,
  investigationAcquisitionStatuses,
  renderInvestigationProgress,
} from '../investigation/investigationProgress';
import {resolveAnalysisInvestigationRequirements} from '../analysisInvestigationRequirements';
import type {InvestigationViewV1} from '../investigation/investigationView';
import type {SkillDefinition} from '../../services/skillEngine/types';
import {projectRuntimeInvestigationRequestReceipt} from '../runtimePerformance';
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
    // Without contract progress the decision never changes the request.
    const decision = decideInvestigationTurn({view, request: {index: 3, purpose: 'answer_turn'}});
    expect(decision).toEqual({schemaVersion: 'investigation_turn_decision@1', tools: {kind: 'unchanged'},
      progressMessages: [], foldPlan: {kind: 'none'}, executionPurpose: {kind: 'unchanged'}});
    expect(projectInvestigationReceipt(view, decision)).toEqual({
      requirements: {contract: 'resolved', observed: 0, notObserved: 4, unknownNoProducer: 1, notApplicable: 0},
      evidence: 'unavailable', turns: {used: 2, limit: 8, total: 10}, elapsedMs: 10_000, remainingMs: 50_000, decision: 'no_change'});
    // A decision the receipt cannot name is never recorded as no change.
    expect(() => projectInvestigationReceipt(view, {...decision, tools: {kind: 'changed'}} as never))
      .toThrow('investigation_decision_unrecordable');
  });
});

describe('investigation contract progress decision', () => {
  const requirement = (id: string): InvestigationProgressRequirementV1 => ({id, domain: 'cpu', description: `Requirement ${id}`,
    evidenceMetrics: [`metric.${id}`], producerSkillIds: [`${id}_producer`]});
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const catalog = new Map(ids.map(id => [id, requirement(id)]));
  const view = (overrides: {items?: InvestigationViewV1['requirements']['items']; used?: number; limit?: number;
    evidence?: InvestigationViewV1['evidence']['status']; contract?: InvestigationViewV1['requirements']['contract'];
    evidenceAccess?: InvestigationViewV1['target']['evidenceAccess']; remainingMs?: number} = {}): InvestigationViewV1 => ({
    schemaVersion: 'investigation_view@1', runId: 'run-1', attempt: 1,
    target: {status: 'resolved', sceneId: 'startup', scope: 'scene_wide', deliverable: 'report',
      evidenceAccess: overrides.evidenceAccess ?? 'read_new', taskKind: 'investigation'},
    requirements: {contract: overrides.contract ?? 'resolved', omittedCount: 0,
      items: overrides.items ?? ids.map((id, index) => ({id, required: index !== 0, status: 'not_observed' as const})),
      counts: {observed: 0, notObserved: 5, unknownNoProducer: 0, notApplicable: 0}},
    evidence: {status: overrides.evidence ?? 'read', recordCount: 1, complete: true},
    budget: {providerTurnsUsed: overrides.used ?? 4, providerTurnLimit: overrides.limit ?? 8, totalTurnLimit: 10,
      elapsedMs: 1, remainingMs: overrides.remainingMs ?? 5_000}});
  const input = (overrides: Omit<Partial<InvestigationTurnInput>, 'progress'> & {progress?: Partial<NonNullable<InvestigationTurnInput['progress']>>} = {}):
    InvestigationTurnInput => ({view: overrides.view ?? view(), request: overrides.request ?? {index: 5, purpose: 'answer_turn'},
    progress: {catalog, named: new Set(), messagesSent: 0, ...overrides.progress}});
  const named = (decision: ReturnType<typeof decideInvestigationTurn>) =>
    decision.progressMessages.flatMap(message => message.requirements.map(item => item.id));

  it('is pure, names at most three not-yet-named requirements, required ones first, in one message', () => {
    const state = input({progress: {named: new Set(['b'])}});
    const decision = decideInvestigationTurn(state);
    expect(decision).toEqual(decideInvestigationTurn(state));
    expect(state.progress!.named).toEqual(new Set(['b']));
    expect(decision.progressMessages).toHaveLength(1);
    expect(decision.progressMessages[0]).toEqual({schemaVersion: 'investigation_progress@1',
      requirements: [requirement('c'), requirement('d'), requirement('e')]});
    expect(Object.isFrozen(decision.progressMessages[0])).toBe(true);
    expect(named(decideInvestigationTurn(input({progress: {named: new Set(['b', 'c', 'd', 'e'])}})))).toEqual(['a']);
    expect(named(decideInvestigationTurn(input({progress: {named: new Set(ids)}})))).toEqual([]);
    expect(named(decideInvestigationTurn(input({progress: {messagesSent: 1}})))).toEqual(['b', 'c', 'd']);
    expect(named(decideInvestigationTurn(input({progress: {messagesSent: 2}})))).toEqual([]);
  });

  it.each([
    ['feature off', {progress: undefined}],
    ['existing_only intent', {view: view({evidenceAccess: 'existing_only'})}],
    ['correction continuation', {request: {index: 5, purpose: 'continuation' as const}}],
    ['the first request', {request: {index: 1, purpose: 'answer_turn' as const}}],
    ['the second request', {request: {index: 2, purpose: 'answer_turn' as const}}],
    ['no acquisition turn after the next request', {view: view({used: 8, limit: 8})}],
    ['an exhausted deadline', {view: view({remainingMs: 0})}],
    ['an unread ledger', {view: view({evidence: 'unavailable'})}],
    ['a failed ledger read', {view: view({evidence: 'failed'})}],
    ['an unchecked contract', {view: view({contract: 'not_checked'})}],
    ['an unreachable producer', {progress: {catalog: new Map()}}],
    ['observed, ungated or unknown statuses', {view: view({items: [{id: 'a', required: true, status: 'observed'},
      {id: 'b', required: true, status: 'unknown_no_producer'}, {id: 'c', required: true, status: 'not_applicable'}]})}],
  ] as Array<[string, Parameters<typeof input>[0]]>)('changes nothing for %s', (_label, overrides) => {
    const state = input(overrides);
    if (overrides && 'progress' in overrides && overrides.progress === undefined) delete state.progress;
    expect(decideInvestigationTurn(state).progressMessages).toEqual([]);
  });

  it('starts at the third request however large the turn limit is', () => {
    expect(named(decideInvestigationTurn(input({view: view({used: 2, limit: 49}), request: {index: 3, purpose: 'answer_turn'}}))))
      .toEqual(['b', 'c', 'd']);
  });

  it('records only the requirement ids it named, through the exact receipt projection', () => {
    const decision = decideInvestigationTurn(input());
    const observation = projectInvestigationReceipt(view(), decision);
    expect(observation).toMatchObject({decision: 'progress', progress: {messages: 1, requirementIds: ['b', 'c', 'd']}});
    const base = {requestIndex: 5, attempt: 1, purpose: 'answer_turn', offsetMs: 3, status: 'observed'};
    expect(projectRuntimeInvestigationRequestReceipt({...base, ...observation})).toEqual({...base, ...observation});
    expect(JSON.stringify(observation)).not.toMatch(/Requirement b|metric\.b|b_producer/);
    // Progress facts exist exactly for a progress decision, and carry ids only.
    const unchanged = projectInvestigationReceipt(view(), decideInvestigationTurn(input({progress: {messagesSent: 2}})));
    expect(unchanged).toMatchObject({decision: 'no_change'});
    expect(unchanged).not.toHaveProperty('progress');
    for (const invalid of [{...observation, progress: undefined}, {...unchanged, progress: observation.progress},
      {...observation, progress: {messages: 1, requirementIds: ['Not An Id']}},
      {...observation, progress: {messages: 1, requirementIds: ['b', 'b']}},
      {...observation, progress: {messages: 2, requirementIds: ['b']}},
      {...observation, progress: {...observation.progress, value: 12}}]) {
      expect(projectRuntimeInvestigationRequestReceipt({...base, ...invalid})).toBeUndefined();
    }
  });

  it('renders its contract data after the template, byte-stably', () => {
    const [message] = decideInvestigationTurn(input()).progressMessages;
    const text = renderInvestigationProgress('TEMPLATE', message);
    expect(text).toBe(renderInvestigationProgress('TEMPLATE', message));
    expect(text.startsWith('TEMPLATE\n\n')).toBe(true);
    expect(JSON.parse(text.slice('TEMPLATE\n\n'.length))).toEqual({context: 'investigation_progress', data: message});
  });
});

describe('investigation contract progress catalog', () => {
  const declaration = {window: {start: 'begin', end: 'end'},
    metrics: [{domain: 'cpu', metric_id: 'metric.b', value: 'duration', unit: 'ns', status: 'status'}]};
  const producer = (name: string, type: SkillDefinition['type'] = 'atomic'): SkillDefinition => ({name, version: '1', type,
    meta: {display_name: name, description: 'Fixture'}, sql: 'SELECT 1', investigation_evidence: declaration} as SkillDefinition);
  const requirements = () => {
    const registry = registryWith(contract);
    return resolveAnalysisInvestigationRequirements({intent: intent(registry.registryFingerprint), strategyRegistry: registry});
  };

  it('keeps requirements with a producer invoke_skill can reach, with contract fields and sorted producer ids', () => {
    const catalog = buildInvestigationProgressCatalog({requirements: requirements(), invokeSkillExposed: true,
      skills: [producer('z_producer'), producer('a_producer'), producer('comparison_only', 'comparison'),
        producer('pipeline_only', 'pipeline_definition')]});
    expect([...catalog.keys()]).toEqual(['not_yet']);
    expect(catalog.get('not_yet')).toEqual({id: 'not_yet', domain: 'cpu', description: 'Declared, only partially captured',
      evidenceMetrics: ['metric.b'], producerSkillIds: ['a_producer', 'z_producer']});
  });

  it('reaches nothing when invoke_skill is not exposed, the contract is unresolved or no Skill declares the metric', () => {
    expect(buildInvestigationProgressCatalog({requirements: requirements(), invokeSkillExposed: false,
      skills: [producer('a_producer')]}).size).toBe(0);
    expect(buildInvestigationProgressCatalog({requirements: {...requirements(), status: 'not_checked'}, invokeSkillExposed: true,
      skills: [producer('a_producer')]}).size).toBe(0);
    expect(buildInvestigationProgressCatalog({requirements: requirements(), invokeSkillExposed: true,
      skills: [producer('comparison_only', 'comparison')]}).size).toBe(0);
  });

  it('carries the contract condition as written and gives first-turn statuses only for a read ledger', () => {
    const conditioned = {...declaration, metrics: [{...declaration.metrics[0], metric_id: 'metric.c'}]};
    const catalog = buildInvestigationProgressCatalog({requirements: requirements(), invokeSkillExposed: true,
      skills: [{...producer('gated_producer'), investigation_evidence: conditioned} as SkillDefinition]});
    expect(catalog.get('gated_out')).toMatchObject({condition: 'Only when the gate is high', producerSkillIds: ['gated_producer']});
    expect(investigationAcquisitionStatuses(requirements(), undefined)).toBeUndefined();
    expect([...investigationAcquisitionStatuses(requirements(), ledger([{metricId: 'metric.a', status: 'observed', value: 1}]))!])
      .toEqual([['acquired', 'observed'], ['not_yet', 'not_observed'], ['no_producer', 'unknown_no_producer'],
        ['gated_out', 'not_observed'], ['semantic', 'observed']]);
  });
});
