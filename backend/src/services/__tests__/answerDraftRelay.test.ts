// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {afterEach, beforeEach, describe, expect, it, jest} from '@jest/globals';
import type {StreamingUpdate} from '../../agent/types';
import {createAnswerDraftStream, createProjectedAnswerDraft, readAnswerDraftIdentity} from '../../agentRuntime/answerDraftStream';
import {runtimeSupportsDraftAnswerStreaming} from '../../agentRuntime/runtimeDescriptors';
import {listProductionRuntimeKinds} from '../../agentRuntime/runtimeKinds';
import {renderConclusionContractSidecar} from '../../agent/core/conclusionContract';
import {
  ANSWER_DRAFT_FLUSH_CHARS,
  ANSWER_DRAFT_FLUSH_INTERVAL_MS,
  AnswerDraftRelay,
  createAnswerDraftRelay,
  type AnswerDraftRelayOptions,
} from '../answerDraftRelay';
import {
  clearCodeAwareOutputGuards,
  createCodeAwareStreamingTextProjection,
  registerCodeAwareLookupForEcho,
  registerPrivateAnalysisQueryForEcho,
  revokeCodeAwareOutputGuards,
} from '../security/codeAwareOutputRegistry';
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

describe('projected answer draft', () => {
  const sessionId = 'projected-answer-draft';
  let channel = 0;
  afterEach(() => clearCodeAwareOutputGuards(sessionId));
  function setup(emit?: (update: StreamingUpdate) => void) {
    const events: StreamingUpdate[] = [];
    const draft = createAnswerDraftStream('run-p', emit ?? (update => events.push(update)));
    const projection = createCodeAwareStreamingTextProjection(sessionId, `projected-${channel++}`, 'owner');
    return {events, projected: createProjectedAnswerDraft(draft, projection)};
  }
  const view = (events: StreamingUpdate[]) => events.map(event =>
    [event.type, (event.content as {token?: string}).token ?? null, (event.content as {attempt: number}).attempt]);
  const withdrawn = [['answer_token', 'Intro line\n', 0], ['answer_segment_reset', null, 1]];

  it('withdraws at the first alteration and shows nothing more in the run, across boundaries', () => {
    const {events, projected} = setup();
    for (const text of ['Intro line\n', 'api_key=\n', '"synthetic-secret-123456"\n', 'Later line\n']) projected.write(text);
    projected.boundary();
    projected.write('Next response\n');
    projected.finish();
    expect(view(events)).toEqual(withdrawn);
    expect(JSON.stringify(events)).not.toContain('synthetic-secret-123456');
  });

  it('withdraws when only the held tail reveals a credential', () => {
    const {events, projected} = setup();
    projected.write('Intro line\n');
    projected.write('token = "abcdefgh12345"');
    projected.finish();
    expect(view(events)).toEqual(withdrawn);
  });

  it('withdraws at a boundary whose discarded tail was altered', () => {
    const {events, projected} = setup();
    projected.write('Intro line\n');
    projected.write('token = "abcdefgh12345"');
    expect(projected.boundary()).toBe('token = "[REDACTED_SECRET]"');
    projected.write('Next response\n');
    expect(view(events)).toEqual(withdrawn);
  });

  it('withdraws when a registration arrives while projected text is still held', () => {
    const {events, projected} = setup();
    projected.write('Intro line\n');
    projected.write('synthetic-secret-123456');
    registerCodeAwareLookupForEcho(sessionId, {hits: [{chunkId: 'wiki-chunk',
      snippet: 'token="synthetic-secret-123456"', metadata: {knowledgeSourceId: 'wiki'}}]} as never);
    projected.write('\nLater line\n');
    projected.finish();
    expect(view(events)).toEqual(withdrawn);
    expect(JSON.stringify(events)).not.toContain('synthetic-secret-123456');
  });

  it('withdraws when a write releases nothing because the projection failed safe', () => {
    const {events, projected} = setup();
    projected.write('Intro line\n');
    revokeCodeAwareOutputGuards(sessionId);
    expect(projected.write('more\n')).toBe('');
    expect(view(events)).toEqual(withdrawn);
  });

  it('keeps a clean draft', () => {
    const {events, projected} = setup();
    projected.write('Plain answer\n');
    projected.finish();
    expect(view(events)).toEqual([['answer_token', 'Plain answer\n', 0]]);
  });

  it('is the only path to a draft for every draft-capable runtime', () => {
    // A runtime added here must send a private run's answer text through
    // createProjectedAnswerDraft, with a test like the OpenAI and Claude ones.
    expect(listProductionRuntimeKinds().filter(runtimeSupportsDraftAnswerStreaming))
      .toEqual(['claude-agent-sdk', 'openai-agents-sdk']);
  });

  it('reaches the surface as a revocation: the relay clears what it showed and forwards nothing more', () => {
    jest.useFakeTimers();
    try {
      const delivered: StreamingUpdate[] = [];
      const surface = createAnswerDraftRelay({runtimeKind: 'openai-agents-sdk', runId: 'run-p',
        projectionSessionId: sessionId, privateKnowledge: true, outputLanguage: 'en',
        deliver: update => delivered.push(update)})!;
      const {projected} = setup(update => surface.accept(update));
      projected.write('Intro line\n');
      jest.runOnlyPendingTimers();
      for (const text of ['api_key=\n', '"synthetic-secret-123456"\n', 'Later line\n']) projected.write(text);
      surface.settle();
      expect(delivered.map(update => [update.type, (update.content as {token?: string}).token ?? null]))
        .toEqual([['answer_token', 'Intro line\n'], ['answer_segment_reset', null]]);
      expect(JSON.stringify(delivered)).not.toContain('synthetic-secret-123456');
    } finally { jest.useRealTimers(); }
  });
});
