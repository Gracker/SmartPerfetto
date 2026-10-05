// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {describe, expect, it} from '@jest/globals';
import {createRuntimeTurnCloseoutTape, resolveRuntimeTurnBudget} from '../runtimeTurnCloseout';
import {createRuntimeToolResult, runtimeToolReceiptMetadata} from '../runtimeToolResult';
import {DEFAULT_EXTERNAL_TOOL_RESULT_MAX_CHARS, summarizeExternalToolResult} from '../runtimeLimits';

interface PromptData {
  kind: string;
  completeTranscript: boolean;
  verified: boolean;
  modelConsumptionKnown: boolean;
  omittedCalls: number;
  unavailableResults: number;
  entries: Array<{
    toolCallId: string;
    toolName: string;
    state: string;
    resultFacts?: {success?: boolean; planPhaseId?: string};
    returnedData?: Record<string, unknown>;
    omittedValues?: number;
  }>;
}

function readPromptData(prompt: string | undefined): PromptData {
  expect(prompt).toBeDefined();
  const line = prompt?.split('\n').find(item => item.startsWith('{"kind":"current_run_returned_data_excerpts"'));
  expect(line).toBeDefined();
  return JSON.parse(line!) as PromptData;
}

const question = {query: 'Why did the main thread miss the frame?', priorConclusion: '', outputLanguage: 'en' as const};
const invocation = {toolCallId: 'sql-1', toolName: 'execute_sql', params: {}, extra: {}};

describe('runtime closeout budget', () => {
  it.each([2, 50, 100])('reserves one delivery call inside the total budget of %i', maxTurns => {
    expect(resolveRuntimeTurnBudget(maxTurns)).toEqual({
      totalTurns: maxTurns, acquisitionTurns: maxTurns - 1, deliveryTurns: 1,
    });
  });

  it('does not add a delivery call to a single-turn configuration', () => {
    expect(resolveRuntimeTurnBudget(1)).toEqual({totalTurns: 1, acquisitionTurns: 1, deliveryTurns: 0});
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'fails closed to one total call for invalid budget %s', maxTurns => {
      expect(resolveRuntimeTurnBudget(maxTurns)).toEqual({totalTurns: 1, acquisitionTurns: 1, deliveryTurns: 0});
    },
  );
});

describe('runtime closeout returned-data tape', () => {
  it('retains actual values and producer phase facts beyond the external transport excerpt', async () => {
    const tape = createRuntimeTurnCloseoutTape();
    const result = createRuntimeToolResult({
      diagnosticNotes: 'unrelated explanation '.repeat(DEFAULT_EXTERNAL_TOOL_RESULT_MAX_CHARS),
      rows: [{evidenceId: 'ev-main-thread', dur: 0, blockedByIo: false, wakeupCause: null}],
      success: true,
      planPhaseId: 'payload-phase',
    }, {facts: {success: false, planPhaseId: 'producer-phase'}});
    expect(summarizeExternalToolResult(result)).not.toContain('ev-main-thread');
    await tape.observe({...invocation, phase: 'completed', result});

    const data = readPromptData(tape.buildPrompt(question));
    expect(data.entries).toHaveLength(1);
    expect(data.entries[0]).toMatchObject({
      state: 'returned', resultFacts: {success: false, planPhaseId: 'producer-phase'},
      returnedData: {rows: [{evidenceId: 'ev-main-thread', dur: 0, blockedByIo: false, wakeupCause: null}]},
    });
    expect(data.entries[0].omittedValues).toBeGreaterThan(0);
    expect(data.entries[0].returnedData?.diagnosticNotes).toContain('[omitted: byte budget]');
  });

  it('uses structured data and receipts when presentation text was shortened or contradicts them', async () => {
    const tape = createRuntimeTurnCloseoutTape();
    await tape.observe({...invocation, phase: 'completed', result: {
      _meta: runtimeToolReceiptMetadata({success: false, planPhaseId: 'phase-2'}),
      structuredContent: {rows: [{id: 'evidence-2', value: null}], success: true},
      content: [{type: 'text', text: '[truncated] {"success":true,"value":999}'}],
    }});
    expect(readPromptData(tape.buildPrompt(question)).entries[0]).toMatchObject({
      resultFacts: {success: false, planPhaseId: 'phase-2'},
      returnedData: {rows: [{id: 'evidence-2', value: null}]},
    });
    expect(tape.buildPrompt(question)).not.toContain('999');
  });

  it('admits a timeout delivery only after data returned and names the exhausted budget', async () => {
    const tape = createRuntimeTurnCloseoutTape();
    await tape.observe({...invocation, phase: 'started'});
    await tape.observe({...invocation, toolCallId: 'sql-2', phase: 'failed', error: new Error('boom')});
    expect(tape.hasReturnedData()).toBe(false);
    await tape.observe({...invocation, phase: 'completed', result: createRuntimeToolResult({rows: [{dur: 9}]})});
    expect(tape.hasReturnedData()).toBe(true);
    expect(tape.buildPrompt({...question, budgetExhausted: 'timeout'})).toContain('(timeout: turn_limit is the turn cap');
    expect(tape.buildPrompt(question)).toContain('(turn_limit: turn_limit is the turn cap');
    expect(tape.buildPrompt({...question, outputLanguage: 'zh-CN', budgetExhausted: 'timeout'})).toContain('本轮调查已耗尽预算（timeout：');
  });

  it('does not count a returned result that could not be projected as deliverable data', async () => {
    const tape = createRuntimeTurnCloseoutTape();
    const unreadable = {get content(): never { throw new Error('unreadable payload'); }};
    await tape.observe({...invocation, phase: 'completed', result: unreadable});
    expect(readPromptData(tape.buildPrompt(question)).entries).toEqual([
      expect.objectContaining({state: 'returned', omittedValues: 1})]);
    expect(tape.hasReturnedData()).toBe(false);
  });

  it('records pending and failed outcomes without exposing arguments, credentials or exception text', async () => {
    const tape = createRuntimeTurnCloseoutTape();
    const privateInvocation = {
      ...invocation, params: {token: 'argument-secret'}, extra: {authorization: 'Bearer extra-secret'},
    };
    await tape.observe({...privateInvocation, phase: 'started'});
    await tape.observe({...privateInvocation, toolCallId: 'sql-2', phase: 'failed',
      error: new Error('request https://user:credential-secret@example.invalid failed: private-source-text'),
    });
    const prompt = tape.buildPrompt(question);
    expect(readPromptData(prompt).entries).toEqual([
      {toolCallId: 'sql-1', toolName: 'execute_sql', state: 'pending'},
      {toolCallId: 'sql-2', toolName: 'execute_sql', state: 'failed'},
    ]);
    for (const secret of ['argument-secret', 'extra-secret', 'credential-secret', 'private-source-text']) {
      expect(prompt).not.toContain(secret);
    }
  });

  it('replaces a pending record with its returned data without inventing success or verification', async () => {
    const tape = createRuntimeTurnCloseoutTape();
    await tape.observe({...invocation, phase: 'started'});
    await tape.observe({...invocation, phase: 'completed', result: {
      content: [{type: 'text', text: '{"rows":[{"count":0}]}'}],
    }});
    expect(readPromptData(tape.buildPrompt(question))).toEqual({
      kind: 'current_run_returned_data_excerpts',
      completeTranscript: false, verified: false, modelConsumptionKnown: false,
      omittedCalls: 0, unavailableResults: 0,
      entries: [{toolCallId: 'sql-1', toolName: 'execute_sql',
        state: 'returned', resultFacts: {}, returnedData: {rows: [{count: 0}]}}],
    });
  });

  it('projects private source into references while preserving the original execution outcome', async () => {
    const tape = createRuntimeTurnCloseoutTape();
    const result = createRuntimeToolResult({
      success: true,
      reference: {
        referenceId: 'source-ref-1', codebaseId: 'app-1', lineRange: {start: 11, end: 15},
        filePath: '/private/proprietary/Frame.java', symbol: 'InternalPrivateFrame',
        text: 'private proprietary source code',
      },
    }, {facts: {success: false, planPhaseId: 'source-phase'}});
    await tape.observe({...invocation, toolName: 'mcp__smartperfetto__read_codebase_file', phase: 'completed', result});
    const prompt = tape.buildPrompt(question);
    expect(readPromptData(prompt).entries[0]).toMatchObject({
      resultFacts: {success: false, planPhaseId: 'source-phase'},
      returnedData: {
        sourceRefs: [{referenceId: 'source-ref-1', codebaseId: 'app-1', lineRange: {start: 11, end: 15},
          snippetHash: expect.any(String), snippetLength: 31}],
      },
    });
    for (const privateText of ['/private/proprietary/Frame.java', 'InternalPrivateFrame', 'private proprietary source code']) {
      expect(prompt).not.toContain(privateText);
    }
  });

  it('fails closed when a sensitive source result has an unsupported shape', async () => {
    const tape = createRuntimeTurnCloseoutTape();
    await tape.observe({...invocation, toolName: 'lookup_app_source', phase: 'completed',
      result: createRuntimeToolResult({success: true, rawSource: 'unrecognized-private-source'}),
    });
    const prompt = tape.buildPrompt(question);
    expect(prompt).not.toContain('unrecognized-private-source');
    expect(readPromptData(prompt).entries[0]).toMatchObject({
      resultFacts: {success: true}, returnedData: {outcome: 'rejected', chunkRefs: []},
    });
  });

  it('bounds the retained call count and explicitly records discarded calls', async () => {
    const tape = createRuntimeTurnCloseoutTape();
    for (let i = 0; i < 50; i++) {
      await tape.observe({...invocation, toolCallId: `sql-${i}`, phase: 'completed',
        result: createRuntimeToolResult({evidenceId: `evidence-${i}`, value: i}),
      });
    }
    const data = readPromptData(tape.buildPrompt(question));
    expect(data.entries.length).toBeLessThanOrEqual(32);
    expect(data.omittedCalls + data.entries.length).toBe(50);
    expect(data.entries[data.entries.length - 1]?.returnedData).toMatchObject({evidenceId: 'evidence-49', value: 49});
    expect(data.entries.some(entry => entry.toolCallId === 'sql-0')).toBe(false);
    expect(data.completeTranscript).toBe(false);
  });

  it('bounds bytes for large results and labels both omitted calls and omitted row values', async () => {
    const tape = createRuntimeTurnCloseoutTape({maxBytes: 4096});
    for (let i = 0; i < 20; i++) {
      await tape.observe({...invocation, toolCallId: `sql-${i}`, phase: 'completed',
        result: createRuntimeToolResult({
          details: '帧'.repeat(2000), rows: Array.from({length: 100}, (_, row) => ({row, duration: row})),
        }),
      });
    }
    const data = readPromptData(tape.buildPrompt(question));
    expect(Buffer.byteLength(JSON.stringify(data.entries))).toBeLessThanOrEqual(4096);
    expect(data.omittedCalls).toBeGreaterThan(0);
    expect(data.entries.length).toBeGreaterThan(0);
    expect(data.entries[data.entries.length - 1]?.omittedValues).toBeGreaterThan(0);
    expect(data.entries[data.entries.length - 1]?.returnedData?.rows).toContain('[omitted: 84 items]');
    expect(JSON.stringify(data)).not.toContain('\uFFFD');
  });

  it('records an unavailable result without replacing it with a guessed failure or successful result', async () => {
    const tape = createRuntimeTurnCloseoutTape();
    const result = {get content(): never { throw new Error('private-projection-error'); }};
    await tape.observe({...invocation, phase: 'completed', result});
    const prompt = tape.buildPrompt(question);
    expect(readPromptData(prompt)).toMatchObject({
      unavailableResults: 1,
      entries: [{toolCallId: 'sql-1', toolName: 'execute_sql', state: 'returned', omittedValues: 1}],
    });
    expect(prompt).not.toContain('private-projection-error');
  });

  it('uses the shipped English and Chinese delivery constraints with an honest empty evidence record', () => {
    const tape = createRuntimeTurnCloseoutTape();
    const english = tape.buildPrompt({...question, priorConclusion: 'Earlier hypothesis, still unverified.'});
    const chinese = tape.buildPrompt({...question, outputLanguage: 'zh-CN'});
    expect(english).toContain('The investigation remains incomplete');
    expect(english).toContain('Tools are disabled');
    expect(english).toContain('Failed or pending calls provide no facts');
    expect(english).toContain('Earlier hypothesis, still unverified.');
    expect(chinese).toContain('调查状态仍是不完整');
    expect(chinese).toContain('工具已关闭');
    for (const prompt of [english, chinese]) {
      expect(readPromptData(prompt)).toMatchObject({
        entries: [], completeTranscript: false, verified: false, modelConsumptionKnown: false,
      });
      expect(prompt).not.toMatch(/\{\{(?:original_query|prior_conclusion|returned_data)\}\}/);
    }
  });
});

describe('runtime empty-body continuation prompt', () => {
  it('asks for the missing body from the same returned data, not for a budget-exhausted closeout', async () => {
    const tape = createRuntimeTurnCloseoutTape();
    expect(tape.hasReturnedData()).toBe(false);
    await tape.observe({...invocation, phase: 'completed', result: createRuntimeToolResult({
      rows: [{anr_type: 'input', ts: 1041}], success: true,
    })});
    expect(tape.hasReturnedData()).toBe(true);
    const declarationOnly = '<!-- smartperfetto:conclusion-contract {"claims":[]} -->';
    for (const outputLanguage of ['en', 'zh-CN'] as const) {
      const prompt = tape.buildEmptyBodyPrompt({...question, priorConclusion: declarationOnly, outputLanguage});
      expect(prompt).toContain(question.query);
      expect(prompt).toContain(declarationOnly);
      expect(readPromptData(prompt).entries[0].returnedData).toMatchObject({rows: [{anr_type: 'input', ts: 1041}]});
      // The run finished: nothing here frames it as an exhausted budget.
      expect(prompt).not.toMatch(/budget_exhausted|turn_limit|耗尽预算/);
      expect(prompt).not.toContain('{{');
    }
  });
});
