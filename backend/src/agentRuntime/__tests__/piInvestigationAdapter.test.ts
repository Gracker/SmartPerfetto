// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import {createPiInvestigationAdapter} from '../engines/pi/piInvestigationAdapter';
import {
  createPiInvestigationConvertToLlm,
  INVESTIGATION_PROGRESS_ENV,
  PI_INVESTIGATION_PROGRESS_ROLE,
  preparePiInvestigationProgress,
} from '../engines/pi/piInvestigationProgress';
import type {InvestigationViewSource, InvestigationViewV1} from '../investigation/investigationView';
import type {InvestigationProgressRequirementV1} from '../investigation/investigationTurnDecision';
import {buildStrategyRegistrySnapshotFromDefinitions, getRegisteredScenes} from '../../agentv3/strategyLoader';
import type {AnalysisTurnIntent} from '../analysisTurnIntent';

const view: InvestigationViewV1 = {schemaVersion: 'investigation_view@1', runId: 'run-1', attempt: 1,
  target: {status: 'resolved', sceneId: 'startup', scope: 'scene_wide', deliverable: 'answer', evidenceAccess: 'read_new',
    taskKind: 'investigation'},
  requirements: {contract: 'resolved', items: [], omittedCount: 0,
    counts: {observed: 1, notObserved: 2, unknownNoProducer: 3, notApplicable: 0}},
  evidence: {status: 'read', recordCount: 4, complete: true},
  budget: {providerTurnsUsed: 1, providerTurnLimit: 6, totalTurnLimit: 8, elapsedMs: 120, remainingMs: 9_000}};

function adapter(overrides: {active?: () => boolean; accepts?: () => boolean; record?: (receipt: unknown) => void;
  derive?: () => InvestigationViewV1} = {}) {
  const records: unknown[] = [];
  const source: InvestigationViewSource = {derive: jest.fn(overrides.derive ?? (() => view)), refreshBudget: current => current};
  const created = createPiInvestigationAdapter({view: source, isActive: overrides.active ?? (() => true), attempt: () => 2,
    purpose: () => 'continuation', accepts: overrides.accepts ?? (() => true),
    record: overrides.record ?? (receipt => {records.push(receipt);})});
  const prepare = (context: {messages: unknown[]; tools?: unknown[]}, signal?: AbortSignal) =>
    created.prepareRequest({context, model: {} as never, thinkingLevel: 'off'} as never, signal);
  return {created, prepare, records, source};
}

describe('Pi investigation prepareRequest adapter', () => {
  it('fixes the request, records view counts, Agent-context shape and budget, and returns no update', () => {
    const {created, prepare, records} = adapter();
    const tool = {name: 'execute_sql', description: 'Run SQL', parameters: {type: 'object'}, execute: () => 'ignored'};
    expect(created.currentRequest()).toBeUndefined();
    expect(prepare({messages: [{role: 'user', content: 'abc'}], tools: [tool]})).toBeUndefined();
    expect(created.currentRequest()).toEqual({index: 1, purpose: 'continuation'});
    expect(records).toEqual([{requestIndex: 1, attempt: 2, purpose: 'continuation', status: 'observed',
      // Keys plus string values; the tool's execute function is not measured.
      agentContext: {messageCount: 1, toolCount: 1, approxMessageChars: 18, approxToolChars: 53},
      requirements: {contract: 'resolved', observed: 1, notObserved: 2, unknownNoProducer: 3, notApplicable: 0},
      evidence: 'read', turns: {used: 1, limit: 6, total: 8}, elapsedMs: 120, remainingMs: 9_000, decision: 'no_change'}]);
  });

  it('bounds each value separately: only the overrunning value is a lower bound, the rest stay cached', () => {
    const {prepare, records} = adapter();
    const huge = {role: 'toolResult', content: Array.from({length: 60_000}, () => ({type: 'text', text: 'x'}))};
    const small = {role: 'user', content: 'q'};
    const after = {role: 'assistant', content: 'later'};
    prepare({messages: [huge, small, after]});
    prepare({messages: [small, after]});
    const [first, second] = records as Array<{agentContext: {approxMessageChars: number; lowerBound?: true}}>;
    expect(first.agentContext.lowerBound).toBe(true);
    // Values after the overrun were walked in full and cached: small (16) + after (25).
    expect(second.agentContext).toEqual({messageCount: 2, toolCount: 0, approxMessageChars: 41, approxToolChars: 0});
    expect(first.agentContext.approxMessageChars).toBeGreaterThan(41);
  });

  it('skips measurement for a dropped or inactive request but still records its ordinal', () => {
    let accepts = false;
    let active = true;
    const {created, prepare, records, source} = adapter({accepts: () => accepts, active: () => active});
    prepare({messages: [{role: 'user', content: 'dropped'}]});
    accepts = true;
    active = false;
    prepare({messages: []});
    active = true;
    const controller = new AbortController();
    controller.abort();
    prepare({messages: []}, controller.signal);
    expect(records).toEqual([1, 2, 3].map(requestIndex => ({requestIndex, attempt: 2, purpose: 'continuation', status: 'inactive'})));
    expect(source.derive).not.toHaveBeenCalled();
    expect(created.currentRequest()).toEqual({index: 3, purpose: 'continuation'});
  });

  it('never throws into the loop and records nothing after disposal', () => {
    const throwing = adapter({record: () => {throw new Error('recorder sealed');}});
    expect(throwing.prepare({messages: []})).toBeUndefined();
    const failed = adapter({derive: () => {throw new Error('PRIVATE_VIEW_FAILURE');}});
    expect(failed.prepare({messages: []})).toBeUndefined();
    expect(failed.records).toEqual([{requestIndex: 1, attempt: 2, purpose: 'continuation', status: 'view_failed',
      agentContext: {messageCount: 0, toolCount: 0, approxMessageChars: 0, approxToolChars: 0}}]);
    failed.created.dispose();
    expect(failed.prepare({messages: []})).toBeUndefined();
    expect(failed.records).toHaveLength(1);
    expect(failed.created.currentRequest()).toEqual({index: 1, purpose: 'continuation'});
  });
});

describe('Pi investigation contract progress at turn boundaries', () => {
  const requirement = (id: string): InvestigationProgressRequirementV1 => ({id, domain: 'cpu', description: `Requirement ${id}`,
    evidenceMetrics: [`metric.${id}`], producerSkillIds: [`${id}_producer`]});
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  const progressView = (): InvestigationViewV1 => ({...view,
    requirements: {...view.requirements, items: ids.map(id => ({id, required: true, status: 'not_observed' as const}))},
    budget: {...view.budget, providerTurnsUsed: 4, providerTurnLimit: 8}});

  function progressAdapter(options: {purpose?: () => 'answer_turn' | 'continuation'; active?: () => boolean;
    derive?: () => InvestigationViewV1; progress?: boolean} = {}) {
    const records: Array<Record<string, unknown>> = [];
    const derive = jest.fn(options.derive ?? progressView);
    const refreshBudget = jest.fn((current: InvestigationViewV1) => ({...current, budget: {...current.budget, elapsedMs: 999}}));
    const created = createPiInvestigationAdapter({view: {derive, refreshBudget}, isActive: options.active ?? (() => true), attempt: () => 1,
      purpose: options.purpose ?? (() => 'answer_turn'), accepts: () => true, record: receipt => {records.push(receipt as never);},
      ...(options.progress === false ? {} : {progress: {catalog: new Map(ids.map(id => [id, requirement(id)]))}})});
    const prepare = () => created.prepareRequest({context: {messages: [], tools: []}, model: {} as never, thinkingLevel: 'off'} as never);
    return {created, prepare, records, derive, refreshBudget};
  }
  const messageIds = (update: unknown) => ((update as {messages?: Array<{role: string; progress: {requirements: Array<{id: string}>}}>})
    ?.messages ?? []).flatMap(message => {
    expect(message.role).toBe(PI_INVESTIGATION_PROGRESS_ROLE);
    return message.progress.requirements.map(item => item.id);
  });

  it('decides at the boundary, caches by the next request index and only records it in prepareRequest', async () => {
    const {created, prepare, records, derive, refreshBudget} = progressAdapter();
    prepare();
    // The first request has no boundary decision: its receipt derives the view.
    expect(derive).toHaveBeenCalledTimes(1);
    // The second request is before the gate: the boundary reads nothing and its receipt derives the view.
    expect(await created.prepareNextTurn()).toBeUndefined();
    expect(derive).toHaveBeenCalledTimes(1);
    prepare();
    expect(derive).toHaveBeenCalledTimes(2);
    expect(messageIds(await created.prepareNextTurn())).toEqual(['a', 'b', 'c']);
    expect(derive).toHaveBeenCalledTimes(3);
    prepare();
    // That request's receipt reuses the boundary's ledger read and re-reads only the budget.
    expect(derive).toHaveBeenCalledTimes(3);
    expect(refreshBudget).toHaveBeenCalledTimes(1);
    expect(records[2].elapsedMs).toBe(999);
    expect(messageIds(await created.prepareNextTurn())).toEqual(['d', 'e', 'f']);
    prepare();
    // Two messages per run: later boundaries change nothing.
    expect(await created.prepareNextTurn()).toBeUndefined();
    prepare();
    expect(records.map(receipt => [receipt.requestIndex, receipt.decision, receipt.progress])).toEqual([
      [1, 'no_change', undefined],
      [2, 'no_change', undefined],
      [3, 'progress', {messages: 1, requirementIds: ['a', 'b', 'c']}],
      [4, 'progress', {messages: 1, requirementIds: ['d', 'e', 'f']}],
      [5, 'no_change', undefined],
    ]);
    expect(JSON.stringify(records)).not.toMatch(/Requirement|metric\.|_producer/);
  });

  it('records no change for a request without a boundary decision, such as a correction prompt', async () => {
    const {created, prepare, records} = progressAdapter({purpose: () => 'continuation'});
    prepare();
    prepare();
    // The next request would be past the first-request gate; its purpose alone keeps the boundary silent.
    expect(await created.prepareNextTurn()).toBeUndefined();
    expect(records.map(receipt => receipt.decision)).toEqual(['no_change', 'no_change']);
  });

  it('never decides when off, inactive, aborted, disposed, or when the view fails', async () => {
    const off = progressAdapter({progress: false});
    expect(await off.created.prepareNextTurn()).toBeUndefined();
    expect(off.derive).not.toHaveBeenCalled();
    const inactive = progressAdapter({active: () => false});
    expect(await inactive.created.prepareNextTurn()).toBeUndefined();
    expect(inactive.derive).not.toHaveBeenCalled();
    const aborted = progressAdapter();
    const controller = new AbortController();
    controller.abort();
    expect(await aborted.created.prepareNextTurn(controller.signal)).toBeUndefined();
    expect(aborted.derive).not.toHaveBeenCalled();
    const failing = progressAdapter({derive: () => {throw new Error('PRIVATE_VIEW_FAILURE');}});
    failing.prepare();
    failing.prepare();
    expect(await failing.created.prepareNextTurn()).toBeUndefined();
    const disposed = progressAdapter();
    disposed.created.dispose();
    expect(await disposed.created.prepareNextTurn()).toBeUndefined();
    expect(disposed.derive).not.toHaveBeenCalled();
    // A boundary before the first-request gate reads nothing.
    const firstRequest = progressAdapter();
    expect(await firstRequest.created.prepareNextTurn()).toBeUndefined();
    expect(firstRequest.derive).not.toHaveBeenCalled();
    const empty = createPiInvestigationAdapter({view: {derive: firstRequest.derive, refreshBudget: current => current}, isActive: () => true,
      attempt: () => 1, purpose: () => 'answer_turn', accepts: () => true, record: () => undefined, progress: {catalog: new Map()}});
    for (let request = 0; request < 2; request++) {
      empty.prepareRequest({context: {messages: [], tools: []}, model: {} as never, thinkingLevel: 'off'} as never);
    }
    const before = firstRequest.derive.mock.calls.length;
    expect(await empty.prepareNextTurn()).toBeUndefined();
    expect(firstRequest.derive.mock.calls.length).toBe(before);
  });
});

describe('Pi convertToLlm for contract progress', () => {
  const progress = {schemaVersion: 'investigation_progress@1' as const, requirements: [{id: 'a', domain: 'cpu',
    description: 'Requirement a', evidenceMetrics: ['metric.a'], producerSkillIds: ['a_producer']}]};
  const standard = [
    {role: 'system', content: 'S', timestamp: 1},
    {role: 'user', content: [{type: 'text', text: 'Q'}], timestamp: 2},
    {role: 'assistant', content: [{type: 'text', text: 'A'}], timestamp: 3},
    {role: 'toolResult', toolCallId: 't', toolName: 'x', content: [{type: 'text', text: 'R'}], isError: false, timestamp: 4},
  ];

  it('keeps every LLM message by identity, like Pi\'s default, and drops other custom roles', async () => {
    const convert = createPiInvestigationConvertToLlm(() => 'unused');
    const converted = await convert([...standard, {role: 'uiNotification', timestamp: 5}] as never);
    expect(converted).toHaveLength(standard.length);
    converted.forEach((message, index) => expect(message).toBe(standard[index]));
  });

  it('sends a progress message as a user text message rendered from its data, never as a system message', async () => {
    const convert = createPiInvestigationConvertToLlm(message => `STATUS ${message.requirements.map(item => item.id).join(',')}`);
    const converted = await convert([...standard, {role: PI_INVESTIGATION_PROGRESS_ROLE, progress, timestamp: 9}] as never);
    expect(converted.slice(0, standard.length)).toEqual(standard);
    expect(converted[standard.length]).toEqual({role: 'user', content: [{type: 'text', text: 'STATUS a'}], timestamp: 9});
    expect(converted.filter(message => message.role === 'system')).toHaveLength(1);
  });

  it('never throws: an unrenderable progress message is dropped', async () => {
    const convert = createPiInvestigationConvertToLlm(() => {throw new Error('render failed');});
    expect(await convert([{role: PI_INVESTIGATION_PROGRESS_ROLE, progress, timestamp: 9}] as never)).toEqual([]);
  });

  it('prepares nothing unless the flag is on, and then binds the real template', () => {
    const startup = getRegisteredScenes().find(definition => definition.scene === 'startup')!;
    const registry = buildStrategyRegistrySnapshotFromDefinitions({definitions: [startup], overlayGeneration: 'test'});
    const intent: AnalysisTurnIntent = {schemaVersion: 1, status: 'resolved', source: 'semantic', taskKind: 'investigation',
      sceneId: 'startup', scope: 'scene_wide', recommendedComplexity: 'full', deliverable: 'report', evidenceAccess: 'read_new',
      registryFingerprint: registry.registryFingerprint};
    const readEvidence = jest.fn(() => undefined);
    const base = {intent, strategyRegistry: registry, skills: [], invokeSkillExposed: true, readEvidence};
    for (const value of [undefined, '', '0', 'false', 'maybe']) {
      expect(preparePiInvestigationProgress({...base, env: {[INVESTIGATION_PROGRESS_ENV]: value}})).toBeUndefined();
    }
    expect(readEvidence).not.toHaveBeenCalled();
    const setup = preparePiInvestigationProgress({...base, env: {[INVESTIGATION_PROGRESS_ENV]: 'true'}})!;
    // An unread ledger gives no first-turn status; no Skill gives no reachable requirement.
    expect(setup).not.toHaveProperty('acquisition');
    expect(setup.catalog.size).toBe(0);
    const text = setup.render(progress);
    expect(text).toContain('## Investigation contract status');
    expect(text).not.toMatch(/<!--|\{\{/);
    expect(text).not.toMatch(/\b(must|should|required to)\b/i);
    expect(text.endsWith(JSON.stringify({context: 'investigation_progress', data: progress}))).toBe(true);
  });
});
