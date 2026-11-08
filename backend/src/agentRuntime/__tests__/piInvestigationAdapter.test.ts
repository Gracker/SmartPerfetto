// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it, jest} from '@jest/globals';
import {createPiInvestigationAdapter} from '../engines/pi/piInvestigationAdapter';
import type {InvestigationViewSource, InvestigationViewV1} from '../investigation/investigationView';

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
  const source: InvestigationViewSource = {derive: jest.fn(overrides.derive ?? (() => view))};
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
