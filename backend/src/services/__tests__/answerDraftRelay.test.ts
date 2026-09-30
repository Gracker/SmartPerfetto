// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import type {StreamingUpdate} from '../../agent/types';
import {createAnswerDraftStream, readAnswerDraftIdentity} from '../../agentRuntime/answerDraftStream';
import {renderConclusionContractSidecar} from '../../agent/core/conclusionContract';
import {
  ANSWER_DRAFT_FLUSH_CHARS,
  ANSWER_DRAFT_FLUSH_INTERVAL_MS,
  AnswerDraftRelay,
  createAnswerDraftRelay,
  type AnswerDraftRelayOptions,
} from '../answerDraftRelay';
import {registerPrivateAnalysisQueryForEcho, revokeCodeAwareOutputGuards} from '../security/codeAwareOutputRegistry';
import {projectOwnerCodeAwareStreamingUpdate} from '../security/codeAwareStreamingUpdateProjection';
import {projectOwnerProvisionalConclusion} from '../security/privateAnalysisProjection';

const token = (text: string, attempt = 0, runId = 'run-1'): StreamingUpdate =>
  ({type: 'answer_token', content: {token: text, runId, attempt}, timestamp: 1});
const reset = (attempt: number, runId = 'run-1'): StreamingUpdate =>
  ({type: 'answer_segment_reset', content: {runId, attempt}, timestamp: 1});

function relay(overrides: Partial<AnswerDraftRelayOptions> = {}) {
  const delivered: StreamingUpdate[] = [];
  const instance = new AnswerDraftRelay({runId: 'run-1', project: update => update,
    deliver: update => delivered.push(update), ...overrides});
  const texts = () => delivered.filter(update => update.type === 'answer_token').map(update => update.content.token).join('');
  return {instance, delivered, texts};
}

describe('answer draft stream', () => {
  it('stamps tokens with run and segment, and resets only after shown text', () => {
    const emitted: StreamingUpdate[] = [];
    const draft = createAnswerDraftStream('run-1', update => emitted.push(update));
    draft.reset();
    expect(emitted).toEqual([]);
    draft.token('Before a tool');
    draft.reset();
    draft.reset();
    draft.token('Answer');
    expect(emitted.map(update => [update.type, update.content])).toEqual([
      ['answer_token', {token: 'Before a tool', runId: 'run-1', attempt: 0}],
      ['answer_segment_reset', {runId: 'run-1', attempt: 1}],
      ['answer_token', {token: 'Answer', runId: 'run-1', attempt: 1}],
    ]);
  });

  it.each([
    [{token: 'x'}], [{token: 'x', runId: '', attempt: 0}], [{token: 'x', runId: 'r', attempt: -1}],
    [{token: 'x', runId: 'r', attempt: 1.5}], ['x'],
  ])('rejects events without a valid identity: %j', content => {
    expect(readAnswerDraftIdentity({content})).toBeUndefined();
  });
});

describe('AnswerDraftRelay', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('coalesces small tokens into one delivery per window and flushes a large buffer at once', () => {
    const {instance, delivered, texts} = relay();
    instance.accept(token('Hello '));
    instance.accept(token('world'));
    expect(delivered).toEqual([]);
    jest.advanceTimersByTime(0);
    expect(delivered).toHaveLength(1);
    instance.accept(token('!'));
    jest.advanceTimersByTime(ANSWER_DRAFT_FLUSH_INTERVAL_MS - 1);
    expect(delivered).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(texts()).toBe('Hello world!');
    instance.accept(token('x'.repeat(ANSWER_DRAFT_FLUSH_CHARS)));
    expect(delivered).toHaveLength(3);
    expect(delivered[2].content).toEqual({token: 'x'.repeat(ANSWER_DRAFT_FLUSH_CHARS), runId: 'run-1', attempt: 0});
  });

  it('drops a buffered flush that a reset overtakes and never delivers it later', () => {
    const {instance, delivered, texts} = relay();
    instance.accept(token('Pre-tool reasoning'));
    instance.accept(reset(1));
    jest.runOnlyPendingTimers();
    expect(delivered.map(update => update.type)).toEqual(['answer_segment_reset']);
    instance.accept(token('Answer', 1));
    jest.runOnlyPendingTimers();
    expect(texts()).toBe('Answer');
  });

  it('drops a late token of a revoked segment, of another run, or without identity', () => {
    const {instance, delivered, texts} = relay();
    instance.accept(reset(2));
    instance.accept(token('late', 1));
    instance.accept(token('foreign', 2, 'run-0'));
    instance.accept({type: 'answer_token', content: {token: 'untyped'}, timestamp: 1});
    instance.accept(reset(1));
    instance.accept(token('current', 2));
    jest.runOnlyPendingTimers();
    expect(texts()).toBe('current');
    expect(delivered.filter(update => update.type === 'answer_segment_reset')).toHaveLength(1);
  });

  it('treats a token of a newer segment as an implicit reset', () => {
    const {instance, delivered, texts} = relay();
    instance.accept(token('old'));
    instance.accept(token('new', 1));
    jest.runOnlyPendingTimers();
    expect(delivered[0]).toMatchObject({type: 'answer_segment_reset', content: {attempt: 1}});
    expect(texts()).toBe('new');
  });

  it('withholds the machine sidecar and delivers the ordinary tail at settlement', () => {
    const {instance, texts} = relay();
    const marker = renderConclusionContractSidecar({schemaVersion: 'conclusion_contract_v1', mode: 'focused_answer',
      conclusions: [], clusters: [], evidenceChain: [], uncertainties: [], nextSteps: []});
    instance.accept(token(`Body\n${marker.slice(0, 12)}`));
    instance.accept(token(marker.slice(12)));
    jest.runOnlyPendingTimers();
    expect(texts()).toBe('Body\n');

    const tail = relay();
    tail.instance.accept(token('Visible\n<'));
    tail.instance.settle();
    tail.instance.accept(token('after settle'));
    jest.runOnlyPendingTimers();
    expect(tail.texts()).toBe('Visible\n<');
  });

  it('dispose drops everything still buffered', () => {
    const {instance, delivered} = relay();
    instance.accept(token('Buffered'));
    instance.dispose();
    jest.runOnlyPendingTimers();
    expect(delivered).toEqual([]);
  });

  it('a projection failure yields no draft and revokes one already shown', () => {
    let fail = false;
    const {instance, delivered, texts} = relay({project: update => {
      if (fail) throw new Error('guard unavailable');
      return update;
    }});
    instance.accept(token('Shown'));
    jest.runOnlyPendingTimers();
    fail = true;
    instance.accept(token('Unsafe'));
    fail = false;
    instance.accept(token('Later'));
    jest.runOnlyPendingTimers();
    expect(texts()).toBe('Shown');
    expect(delivered[delivered.length - 1]).toMatchObject({type: 'answer_segment_reset', content: {runId: 'run-1', attempt: 1}});

    const never = relay({project: () => null});
    never.instance.accept(token('Hidden'));
    jest.runOnlyPendingTimers();
    expect(never.delivered).toEqual([]);
  });

  it('withdraws the draft when the owner projection suppresses a token (structurally)', () => {
    const sessionId = 'draft-relay-private-suppressed';
    registerPrivateAnalysisQueryForEcho(sessionId, 'private question');
    const delivered: StreamingUpdate[] = [];
    const instance = new AnswerDraftRelay({runId: 'run-1', deliver: update => delivered.push(update),
      project: update => projectOwnerCodeAwareStreamingUpdate(sessionId, update, true, 'en')});
    instance.accept(token('Shown first '));
    jest.runOnlyPendingTimers();
    expect(delivered.map(update => update.type)).toEqual(['answer_token']);
    // The guard can no longer vouch for the session's output: the token is withdrawn,
    // never shown as a placeholder.
    revokeCodeAwareOutputGuards(sessionId);
    instance.accept(token('source text'));
    instance.accept(token('later text'));
    jest.runOnlyPendingTimers();
    expect(delivered.map(update => update.type)).toEqual(['answer_token', 'answer_segment_reset']);
    expect(JSON.stringify(delivered)).not.toContain('PRIVATE_OUTPUT_SUPPRESSED');
  });

  it('never lets a throwing delivery escape, on the timer or the size flush, and withdraws the draft', () => {
    let fail = false;
    const delivered: StreamingUpdate[] = [];
    const deliver = (update: StreamingUpdate) => {
      if (fail) throw new Error('analysis_context_changed_restart_required');
      delivered.push(update);
    };
    const timed = new AnswerDraftRelay({runId: 'run-1', project: update => update, deliver});
    timed.accept(token('Shown '));
    jest.runOnlyPendingTimers();
    timed.accept(token('armed'));
    fail = true;
    expect(() => jest.runOnlyPendingTimers()).not.toThrow();
    fail = false;
    timed.accept(token('after withdrawal'));
    jest.runOnlyPendingTimers();
    expect(delivered.map(update => update.content.token)).toEqual(['Shown ']);

    fail = true;
    const sized = new AnswerDraftRelay({runId: 'run-1', project: update => update, deliver});
    expect(() => sized.accept(token('x'.repeat(ANSWER_DRAFT_FLUSH_CHARS)))).not.toThrow();
    fail = false;
    sized.accept(token('later'));
    jest.runOnlyPendingTimers();
    expect(delivered).toHaveLength(1);
  });

  it('gives no draft to a private-knowledge or source-access session', () => {
    const create = (privateKnowledge: boolean) => createAnswerDraftRelay({runtimeKind: 'openai-agents-sdk',
      runId: 'run-1', projectionSessionId: 's', privateKnowledge, outputLanguage: 'en', deliver: () => undefined});
    expect(create(true)).toBeUndefined();
    expect(create(false)).toBeInstanceOf(AnswerDraftRelay);
  });

  it('in a plain session shows a split credential exactly as the final body does: both projections are the identity', () => {
    const sessionId = 'draft-relay-plain';
    const first = token('Authorization: Bearer ');
    const second = token('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(projectOwnerCodeAwareStreamingUpdate(sessionId, first, false, 'en')).toBe(first);
    expect(projectOwnerCodeAwareStreamingUpdate(sessionId, second, false, 'en')).toBe(second);
    const body = 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789';
    expect(projectOwnerProvisionalConclusion(false, sessionId, body, 'en')).toBe(body);
  });

  it('creates no relay for a runtime without the draft reset contract', () => {
    expect(createAnswerDraftRelay({runtimeKind: 'pi-agent-core', runId: 'run-1', projectionSessionId: 's',
      privateKnowledge: false, outputLanguage: 'en', deliver: () => undefined})).toBeUndefined();
    expect(createAnswerDraftRelay({runtimeKind: undefined, runId: 'run-1', projectionSessionId: 's',
      privateKnowledge: false, outputLanguage: 'en', deliver: () => undefined})).toBeUndefined();
  });
});
