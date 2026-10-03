// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  classifyStopResponse,
  evaluateStopScenario,
  normalizeAgentFrame,
  normalizeConversationFrame,
  parseLoopbackOrigin,
  redactStopObservation,
  splitSseFrames,
  summarizeStopChecks,
  type SseFrame,
  type StopAttempt,
  type StopCheckResult,
  type StopObservedEvent,
  type StopScenario,
  type StopScenarioObservation,
  type StopStorageObservation,
} from '../stopSemanticsChecks';

const RUN = 'session-1:1';
const BODY = 'Startup took 812 ms; bindApplication dominated at 430 ms.';
const REVOKED = 'Let me check the startup slices before answering the question.';

// --- Agent route frames (`/api/agent/v1/runs/:runId/stream`) ---------------
const agentFrame = (event: string, data: Record<string, unknown>, id?: number): SseFrame =>
  ({event, ...(id !== undefined ? {id: String(id)} : {}), data: JSON.stringify({type: event, runId: RUN, data})});
const agent = {
  token: (token: string, attempt = 0, runId = RUN) => agentFrame('answer_token', {token, runId, attempt}),
  reset: (attempt: number) => agentFrame('answer_segment_reset', {runId: RUN, attempt}),
  provisional: (id: number, conclusion = BODY) =>
    agentFrame('conclusion', {provisional: true, verification: 'pending', conclusion}, id),
  plain: (id: number) => agentFrame('conclusion', {conclusion: BODY}, id),
  reviewStarted: (id: number, answerReadable = true) =>
    agentFrame('progress', {phase: 'final_review', stage: 'started', deadlineAt: 1, ...(answerReadable ? {answerReadable} : {})}, id),
  reviewFinished: (id: number, outcome: string, reason?: string) =>
    agentFrame('progress', {phase: 'final_review', stage: 'finished', outcome, ...(reason ? {reason} : {})}, id),
  completed: (id: number, extra: Record<string, unknown> = {}) => agentFrame('analysis_completed', {conclusion: BODY,
    reportUrl: '/api/reports/r1', claimVerificationResult: {status: 'partial'}, ...extra}, id),
  cancelled: (id: number) => agentFrame('analysis_cancelled', {reason: 'Analysis cancelled by user'}, id),
};

// --- Conversation frames (`/api/agent/v1/conversation/:id/stream`) ---------
const convFrame = (event: string, payload: Record<string, unknown>, id?: number): SseFrame =>
  ({event, ...(id !== undefined ? {id: String(id)} : {}),
    data: JSON.stringify({type: event, sessionId: 's', runId: RUN, ...(id !== undefined ? {seqId: id} : {}), ...payload})});
const conv = {
  token: (token: string, attempt = 0) => convFrame('runtime_update',
    {liveOnly: true, update: {type: 'answer_token', content: {token, runId: RUN, attempt}}}),
  reset: (attempt: number) => convFrame('runtime_update',
    {liveOnly: true, update: {type: 'answer_segment_reset', content: {runId: RUN, attempt}}}),
  reviewStarted: (id: number) => convFrame('runtime_update',
    {update: {type: 'progress', content: {phase: 'final_review', stage: 'started', answerReadable: true}}}, id),
  provisional: (id: number) => convFrame('provisional_answer', {message: BODY, verification: 'pending'}, id),
  completed: (id: number, finalResult: Record<string, unknown> = {}) =>
    convFrame('run_completed', {outcome: {kind: 'answered', message: BODY, finalResult}, enrichmentPending: false}, id),
  cancelled: (id: number) => convFrame('run_completed', {outcome: {kind: 'cancelled', message: ''}, enrichmentPending: false}, id),
};

const events = (normalize: typeof normalizeAgentFrame, frames: SseFrame[]): StopObservedEvent[] =>
  frames.map((frame, index) => normalize(frame, index, index * 10));
const agentEvents = (frames: SseFrame[]) => events(normalizeAgentFrame, frames);
const convEvents = (frames: SseFrame[]) => events(normalizeConversationFrame, frames);

function agentStorage(over: Partial<StopStorageObservation> = {}, replay: SseFrame[] = []): StopStorageObservation {
  return {read: 'ok', sessionStatus: 'completed', statusReportUrlPresent: true,
    turns: [{body: BODY, completed: true, partial: false}], replay: {read: 'ok', events: agentEvents(replay)}, ...over};
}

function observe(over: Partial<StopScenarioObservation> & {events: StopObservedEvent[]}): StopScenarioObservation {
  return {entry: 'agent', scenario: 'no_stop', runId: RUN, subscriptionGapMs: 12, streamEnd: 'closed', stops: [], ...over};
}

const stop = (over: Partial<StopAttempt>): StopAttempt =>
  ({order: 1, trigger: 'provisional', sentAfterEventIndex: 0, httpStatus: 200, ...over});

function statusOf(results: StopCheckResult[], id: string): string | undefined {
  return results.find(result => result.id === id)?.status;
}

describe('stop semantics transport helpers', () => {
  it('accepts only explicit loopback http origins', () => {
    expect(parseLoopbackOrigin('http://127.0.0.1:13100')).toBe('http://127.0.0.1:13100');
    expect(parseLoopbackOrigin('http://[::1]:13100/')).toBe('http://[::1]:13100');
    for (const [raw, code] of [
      ['http://localhost:3000', 'not_loopback'], ['http://10.0.0.2:3000', 'not_loopback'],
      ['https://127.0.0.1:3000', 'protocol_invalid'], ['http://u:p@127.0.0.1:3000', 'credentials_forbidden'],
      ['http://127.0.0.1', 'port_required'], ['http://127.0.0.1:3000/api', 'shape_invalid'], ['nonsense', 'invalid'],
    ]) expect(() => parseLoopbackOrigin(raw)).toThrow(`stop_verifier_base_url_${code}`);
  });

  it('splits SSE frames, keeps ids, drops keep-alives and holds partial frames', () => {
    const {frames, rest} = splitSseFrames(': keep-alive\n\nid: 7\nevent: conclusion\ndata: {"a":1}\n\r\nevent: answer_token\ndata: x\n\nevent: part');
    expect(frames).toEqual([{event: 'conclusion', id: '7', data: '{"a":1}'}, {event: 'answer_token', data: 'x'}]);
    expect(rest).toBe('event: part');
  });

  it('normalizes both surfaces into the same event kinds', () => {
    expect(agentEvents([agent.token('a', 2), agent.provisional(3), agent.reviewStarted(4), agent.completed(5)])
      .map(event => [event.kind, event.attempt, event.hasSseId])).toEqual([
      ['draft_token', 2, false], ['provisional', undefined, true], ['review_started', undefined, true],
      ['completed', undefined, true]]);
    const [token, provisional, done] = convEvents([conv.token('a'), conv.provisional(1),
      conv.completed(2, {partial: true, terminationReason: 'review_not_finished'})]);
    expect(token).toMatchObject({kind: 'draft_token', liveOnly: true, runId: RUN, attempt: 0});
    expect(provisional).toMatchObject({kind: 'provisional', verificationPending: true});
    expect(done.verdict).toEqual({partial: true, terminationReason: 'review_not_finished', outcomeKind: 'answered'});
  });

  it('classifies stop responses per surface', () => {
    expect(classifyStopResponse('agent', stop({status: 'review_stop_requested'}))).toBe('review_only');
    expect(classifyStopResponse('agent', stop({status: 'completed', outcome: 'committed'}))).toBe('force_committed');
    expect(classifyStopResponse('agent', stop({status: 'completed', outcome: 'review_not_finished'}))).toBe('force_fallback');
    expect(classifyStopResponse('agent', stop({status: 'cancelled', outcome: 'cancelled'}))).toBe('full_cancel');
    expect(classifyStopResponse('agent', stop({status: 'cancelled', outcome: 'already_cancelled'}))).toBe('already_terminal');
    expect(classifyStopResponse('agent', stop({httpStatus: 409, code: 'RUN_NOT_CANCELLABLE'}))).toBe('already_terminal');
    expect(classifyStopResponse('conversation', stop({httpStatus: 409, code: 'CONVERSATION_RUN_NOT_ACTIVE'}))).toBe('already_terminal');
    expect(classifyStopResponse('conversation', stop({status: 'answered'}))).toBe('force_committed');
    expect(classifyStopResponse('conversation', stop({httpStatus: 500}))).toBe('error');
    expect(classifyStopResponse('agent', stop({httpStatus: undefined, requestError: 'timeout'}))).toBe('error');
  });

  it('redacts every body and draft text to a length and digest', () => {
    const obs = observe({events: agentEvents([agent.token(REVOKED), agent.completed(1)]),
      storage: agentStorage({}, [agent.completed(1)])});
    const serialized = JSON.stringify(redactStopObservation(obs));
    expect(serialized).not.toContain(BODY);
    expect(serialized).not.toContain(REVOKED);
    expect(serialized).toContain(`"chars":${BODY.length}`);
  });
});

describe('evaluateStopScenario', () => {
  it('passes a no-stop agent run with drafts, a reset, a provisional answer and a normal commit', () => {
    const live = agentEvents([agent.token(REVOKED, 0), agent.reset(1), agent.token(BODY, 1),
      agent.provisional(4), agent.reviewStarted(5), agent.reviewFinished(6, 'checked'), agent.completed(7)]);
    const results = evaluateStopScenario(observe({events: live, storage: agentStorage({}, [agent.provisional(4), agent.completed(7)])}));
    expect(results.filter(result => result.status !== 'pass')).toEqual([
      expect.objectContaining({id: 'S2.no_review_branch', status: 'not_exercised'}),
      expect.objectContaining({id: 'R.watchdog_fallback', status: 'not_exercised'}),
    ]);
    expect(summarizeStopChecks(results).passed).toBe(true);
  });

  it('marks draft checks not_exercised without drafts and passes the no-review branch', () => {
    const results = evaluateStopScenario(observe({events: agentEvents([agent.plain(1), agent.completed(2)]),
      storage: agentStorage({}, [agent.plain(1), agent.completed(2)])}));
    for (const id of ['S1.draft_identity', 'S1.draft_attempt_order', 'S1.draft_reset_revokes', 'S1.draft_live_only',
      'S1.draft_before_answer', 'S2.provisional_before_completion', 'R.no_draft_replayed', 'R.no_revoked_draft_persisted']) {
      expect(statusOf(results, id)).toBe('not_exercised');
    }
    expect(statusOf(results, 'S2.no_review_branch')).toBe('pass');
  });

  it('fails broken draft identity, order, liveness, revocation and late drafts', () => {
    const live = agentEvents([agent.token('a', 1), agent.token('b', 0), agent.token('c', 1, 'other-run'),
      agent.reset(2), agent.token('stale', 1), {...agent.token('d', 2), id: '9'}, agent.plain(10), agent.token('late', 2),
      agent.completed(11)]);
    const results = evaluateStopScenario(observe({events: live, storage: agentStorage({}, [agent.completed(11)])}));
    for (const id of ['S1.draft_identity', 'S1.draft_attempt_order', 'S1.draft_reset_revokes', 'S1.draft_live_only',
      'S1.draft_before_answer']) expect(statusOf(results, id)).toBe('fail');
  });

  it('requires the conversation draft to be marked liveOnly', () => {
    const notLive = {...conv.token('a'), data: JSON.stringify({type: 'runtime_update', runId: RUN,
      update: {type: 'answer_token', content: {token: 'a', runId: RUN, attempt: 0}}})};
    const results = evaluateStopScenario(observe({entry: 'conversation', events: convEvents([notLive, conv.completed(1)])}));
    expect(statusOf(results, 'S1.draft_live_only')).toBe('fail');
  });

  it('fails a readable review without a provisional answer and a provisional answer after completion', () => {
    const noProvisional = evaluateStopScenario(observe({events: agentEvents([agent.reviewStarted(1), agent.completed(2)])}));
    expect(statusOf(noProvisional, 'S2.provisional_before_completion')).toBe('fail');
    const unreadable = evaluateStopScenario(observe({events: agentEvents([agent.reviewStarted(1, false), agent.completed(2)])}));
    expect(statusOf(unreadable, 'S2.provisional_before_completion')).toBe('not_exercised');
    const late = evaluateStopScenario(observe({events: agentEvents([agent.completed(1), agent.provisional(2)])}));
    expect(statusOf(late, 'S2.provisional_before_completion')).toBe('fail');
  });

  it('fails the no-review branch when review progress appears without a start', () => {
    const results = evaluateStopScenario(observe({events: agentEvents([agent.plain(1), agent.reviewFinished(2, 'not_checked'),
      agent.completed(3)]), storage: agentStorage({}, [agent.completed(3)])}));
    expect(statusOf(results, 'S2.no_review_branch')).toBe('fail');
  });

  describe('stop after the provisional answer', () => {
    const scenario: StopScenario = 'stop_after_provisional';
    const live = (finish = agent.reviewFinished(6, 'not_checked', 'cancelled_by_user')) =>
      agentEvents([agent.provisional(4), agent.reviewStarted(5), finish, agent.completed(7)]);

    it('passes a review-only stop that ends the review and still completes', () => {
      const results = evaluateStopScenario(observe({scenario, events: live(),
        stops: [stop({status: 'review_stop_requested', sentAfterEventIndex: 0})], storage: agentStorage({}, [agent.completed(7)])}));
      expect(statusOf(results, 'S3.first_stop_review_only')).toBe('pass');
      expect(statusOf(results, 'S3.review_stop_verdict')).toBe('pass');
    });

    it('records a legal race when the review finished first or the run already committed', () => {
      const finishedFirst = evaluateStopScenario(observe({scenario, events: live(agent.reviewFinished(6, 'checked')),
        stops: [stop({status: 'review_stop_requested'})]}));
      expect(statusOf(finishedFirst, 'S3.review_stop_verdict')).toBe('legal_race');
      const committed = evaluateStopScenario(observe({scenario, events: live(),
        stops: [stop({httpStatus: 409, code: 'RUN_NOT_CANCELLABLE'})]}));
      expect(statusOf(committed, 'S3.first_stop_review_only')).toBe('legal_race');
      expect(statusOf(committed, 'S3.review_stop_verdict')).toBe('not_exercised');
    });

    it('fails a full cancel after delivery and a review-only stop that never completes', () => {
      const cancelled = evaluateStopScenario(observe({scenario, events: agentEvents([agent.provisional(4), agent.cancelled(5)]),
        stops: [stop({status: 'cancelled', outcome: 'cancelled'})]}));
      expect(statusOf(cancelled, 'S3.first_stop_review_only')).toBe('fail');
      const hung = evaluateStopScenario(observe({scenario, events: agentEvents([agent.provisional(4)]),
        stops: [stop({status: 'review_stop_requested'})]}));
      expect(statusOf(hung, 'S3.first_stop_review_only')).toBe('fail');
      expect(statusOf(hung, 'S3.review_stop_verdict')).toBe('fail');
      expect(statusOf(hung, 'R.single_terminal')).toBe('fail');
    });

    it('is not exercised when no provisional answer arrived', () => {
      const results = evaluateStopScenario(observe({scenario, events: agentEvents([agent.plain(1), agent.completed(2)])}));
      expect(statusOf(results, 'S3.first_stop_review_only')).toBe('not_exercised');
    });
  });

  describe('force stop', () => {
    const scenario: StopScenario = 'force_after_provisional';
    const first = stop({status: 'review_stop_requested'});

    it('passes the committed and fallback branches and checks the fallback turn', () => {
      const committed = evaluateStopScenario(observe({scenario,
        events: agentEvents([agent.provisional(1), agent.completed(2)]),
        stops: [first, stop({order: 2, status: 'completed', outcome: 'committed'})]}));
      expect(statusOf(committed, 'S5.force_stop')).toBe('pass');

      const fallbackVerdict = {partial: true, terminationReason: 'review_not_finished',
        claimVerificationResult: {status: 'not_checked', notCheckedReason: 'review_not_finished'}};
      const fallback = evaluateStopScenario(observe({scenario,
        events: agentEvents([agent.provisional(1), agent.completed(2, fallbackVerdict)]),
        stops: [first, stop({order: 2, status: 'completed', outcome: 'review_not_finished'})],
        storage: agentStorage({turns: [{body: BODY, partial: true, terminationReason: 'review_not_finished',
          claimVerificationStatus: 'not_checked', completed: true}]}, [agent.completed(2, fallbackVerdict)])}));
      expect(statusOf(fallback, 'S5.force_stop')).toBe('pass');
      expect(statusOf(fallback, 'R.watchdog_fallback')).toBe('pass');

      const badTurn = evaluateStopScenario(observe({scenario,
        events: agentEvents([agent.provisional(1), agent.completed(2, fallbackVerdict)]),
        stops: [first, stop({order: 2, status: 'completed', outcome: 'review_not_finished'})],
        storage: agentStorage({}, [agent.completed(2)])}));
      expect(statusOf(badTurn, 'R.watchdog_fallback')).toBe('fail');
    });

    it('passes the cancelled branch, records a race, and fails a repeated review-only answer', () => {
      const cancelled = evaluateStopScenario(observe({scenario, events: agentEvents([agent.provisional(1), agent.cancelled(2)]),
        stops: [first, stop({order: 2, status: 'cancelled', outcome: 'cancelled'})]}));
      expect(statusOf(cancelled, 'S5.force_stop')).toBe('pass');
      const race = evaluateStopScenario(observe({scenario, events: agentEvents([agent.provisional(1), agent.completed(2)]),
        stops: [first, stop({order: 2, httpStatus: 409, code: 'RUN_NOT_ACTIVE'})]}));
      expect(statusOf(race, 'S5.force_stop')).toBe('legal_race');
      const repeated = evaluateStopScenario(observe({scenario, events: agentEvents([agent.provisional(1), agent.completed(2)]),
        stops: [first, stop({order: 2, status: 'review_stop_requested'})]}));
      expect(statusOf(repeated, 'S5.force_stop')).toBe('fail');
      const unsent = evaluateStopScenario(observe({scenario, events: agentEvents([agent.provisional(1), agent.completed(2)]),
        stops: [stop({httpStatus: 409, code: 'RUN_NOT_CANCELLABLE'})]}));
      expect(statusOf(unsent, 'S5.force_stop')).toBe('not_exercised');
    });
  });

  describe('stop before the provisional answer', () => {
    const scenario: StopScenario = 'stop_before_provisional';
    const cancelStop = stop({trigger: 'first_draft', status: 'cancelled', outcome: 'cancelled', sentAfterEventIndex: 0});

    it('passes a full cancel that stores and replays only the cancel marker', () => {
      const results = evaluateStopScenario(observe({scenario, events: agentEvents([agent.token('a'), agent.cancelled(2)]),
        stops: [cancelStop], storage: agentStorage({sessionStatus: 'cancelled', turns: []}, [agent.cancelled(2)])}));
      expect(statusOf(results, 'S4.full_cancel_before_provisional')).toBe('pass');
      expect(statusOf(results, 'S4.cancel_marker_only')).toBe('pass');
      expect(statusOf(results, 'S2.provisional_before_completion')).toBe('not_exercised');
    });

    it('fails when an answer body is stored or replayed after the cancel', () => {
      const results = evaluateStopScenario(observe({scenario, events: agentEvents([agent.token('a'), agent.cancelled(2)]),
        stops: [cancelStop], storage: agentStorage({sessionStatus: 'cancelled'}, [agent.plain(1), agent.cancelled(2)])}));
      expect(statusOf(results, 'S4.full_cancel_before_provisional')).toBe('pass');
      expect(statusOf(results, 'S4.cancel_marker_only')).toBe('fail');
      const answered = evaluateStopScenario(observe({scenario, events: agentEvents([agent.token('a'), agent.completed(2)]),
        stops: [cancelStop]}));
      expect(statusOf(answered, 'S4.full_cancel_before_provisional')).toBe('fail');
    });

    it('records a legal race when the answer was already delivered, and not_exercised without a trigger', () => {
      const race = evaluateStopScenario(observe({scenario, events: agentEvents([agent.token('a'), agent.provisional(2), agent.completed(3)]),
        stops: [stop({trigger: 'first_draft', status: 'review_stop_requested'})]}));
      expect(statusOf(race, 'S4.full_cancel_before_provisional')).toBe('legal_race');
      expect(statusOf(race, 'S4.cancel_marker_only')).toBe('not_exercised');
      const none = evaluateStopScenario(observe({scenario, events: agentEvents([agent.plain(1), agent.completed(2)])}));
      expect(statusOf(none, 'S4.full_cancel_before_provisional')).toBe('not_exercised');
    });

    it('checks the conversation cancel marker turn', () => {
      const storage: StopStorageObservation = {read: 'ok', sessionStatus: 'cancelled', turns: [{partial: true, completed: false}],
        assistantMessages: [], replay: {read: 'ok', events: convEvents([conv.cancelled(3)])}};
      const results = evaluateStopScenario(observe({entry: 'conversation', scenario,
        events: convEvents([conv.token('a'), conv.cancelled(3)]), stops: [cancelStop], storage}));
      expect(statusOf(results, 'S4.cancel_marker_only')).toBe('pass');
    });
  });

  describe('storage', () => {
    it('fails replayed drafts, revoked drafts in history, a mismatched body and missing report metadata', () => {
      const live = agentEvents([agent.token(REVOKED, 0), agent.reset(1), agent.token(BODY, 1), agent.plain(4), agent.completed(5)]);
      const results = evaluateStopScenario(observe({events: live, storage: agentStorage({statusReportUrlPresent: false,
        turns: [{body: `${REVOKED} ${BODY}`, completed: true}]}, [agent.token(REVOKED, 0), agent.completed(5)])}));
      for (const id of ['R.no_draft_replayed', 'R.no_revoked_draft_persisted', 'R.persisted_body_is_verdict',
        'R.report_metadata', 'R.single_terminal']) expect(statusOf(results, id)).toBe(id === 'R.single_terminal' ? 'pass' : 'fail');
    });

    it('fails unreadable storage and duplicate terminals', () => {
      const results = evaluateStopScenario(observe({events: agentEvents([agent.plain(1), agent.completed(2), agent.completed(3)]),
        storage: {read: 'failed', turns: [], replay: {read: 'failed', events: []}}}));
      expect(statusOf(results, 'R.single_terminal')).toBe('fail');
      expect(statusOf(results, 'R.persisted_body_is_verdict')).toBe('fail');
      expect(statusOf(results, 'R.report_metadata')).toBe('fail');
    });

    it('judges the conversation store at the provisional answer', () => {
      const live = convEvents([conv.provisional(1), conv.reviewStarted(2), conv.completed(3)]);
      const base: StopStorageObservation = {read: 'ok', turns: [{completed: true}], assistantMessages: [BODY],
        replay: {read: 'ok', events: convEvents([conv.provisional(1), conv.completed(3)])}};
      const verdict = (midRunHistory?: StopStorageObservation['midRunHistory']) => statusOf(evaluateStopScenario(
        observe({entry: 'conversation', events: live, storage: {...base, ...(midRunHistory ? {midRunHistory} : {})}})),
      'R.conversation_store_verdict_only');
      expect(verdict({read: 'ok', activeRunMatches: true, assistantMessageForRun: false})).toBe('pass');
      expect(verdict({read: 'ok', activeRunMatches: false, assistantMessageForRun: true})).toBe('legal_race');
      expect(verdict({read: 'ok', activeRunMatches: true, assistantMessageForRun: true})).toBe('fail');
      expect(verdict()).toBe('not_exercised');
      const results = evaluateStopScenario(observe({entry: 'conversation', events: live, storage: base}));
      expect(statusOf(results, 'S2.provisional_before_completion')).toBe('pass');
      expect(statusOf(results, 'R.persisted_body_is_verdict')).toBe('pass');
      expect(results.some(result => result.id === 'R.report_metadata')).toBe(false);
    });
  });
});
