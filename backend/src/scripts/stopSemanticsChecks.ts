// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {createHash} from 'node:crypto';

/**
 * Pure evaluation for the manual draft / provisional / stop verifier
 * (`verifyAgentSseStopSemantics.ts`). No I/O: the CLI normalizes what it read
 * from a running backend into these shapes, and this module decides, per
 * check, whether the target branch was hit (`pass`), a legal race decided the
 * outcome (`legal_race`), the branch was not reached (`not_exercised`), or the
 * contract was broken (`fail`). A branch is claimed only from observed events.
 */

export type StopEntry = 'agent' | 'conversation';
export const STOP_SCENARIOS = ['no_stop', 'stop_after_provisional', 'force_after_provisional',
  'stop_before_provisional'] as const;
export type StopScenario = typeof STOP_SCENARIOS[number];
export type StopCheckStatus = 'pass' | 'legal_race' | 'not_exercised' | 'fail';

export interface StopCheckResult {
  id: string;
  status: StopCheckStatus;
  detail: string;
}

// ---------------------------------------------------------------------------
// Target origin
// ---------------------------------------------------------------------------

/** An explicit loopback http origin with a port, no credentials, path, query or hash. */
export function parseLoopbackOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('stop_verifier_base_url_invalid');
  }
  if (url.username || url.password) throw new Error('stop_verifier_base_url_credentials_forbidden');
  if (url.protocol !== 'http:') throw new Error('stop_verifier_base_url_protocol_invalid');
  if (!['127.0.0.1', '[::1]'].includes(url.hostname.toLowerCase())) throw new Error('stop_verifier_base_url_not_loopback');
  if (!url.port) throw new Error('stop_verifier_base_url_port_required');
  if (url.pathname !== '/' || url.search || url.hash) throw new Error('stop_verifier_base_url_shape_invalid');
  return url.origin;
}

// ---------------------------------------------------------------------------
// SSE framing and event normalization
// ---------------------------------------------------------------------------

export interface SseFrame {
  event: string;
  /** Present only when the frame carried an `id:` line (a replay cursor). */
  id?: string;
  data: string;
}

/** Splits complete frames off a text buffer; comment-only frames (keep-alives) are dropped. */
export function splitSseFrames(buffer: string): {frames: SseFrame[]; rest: string} {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const frames: SseFrame[] = [];
  let rest = normalized;
  let separator = rest.indexOf('\n\n');
  while (separator !== -1) {
    const block = rest.slice(0, separator);
    rest = rest.slice(separator + 2);
    separator = rest.indexOf('\n\n');
    let event = 'message';
    let id: string | undefined;
    const data: string[] = [];
    let hasField = false;
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      hasField = true;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'event') event = value.trim();
      else if (field === 'id') id = value.trim();
      else if (field === 'data') data.push(value);
    }
    if (hasField) frames.push({event, ...(id !== undefined ? {id} : {}), data: data.join('\n')});
  }
  return {frames, rest};
}

export type StopEventKind = 'draft_token' | 'draft_reset' | 'provisional' | 'plain_conclusion' | 'review_started'
  | 'review_finished' | 'completed' | 'cancelled' | 'failed' | 'other';

/** The finalized verdict a terminal event (or a stored turn) carries. */
export interface StopVerdict {
  partial?: boolean;
  terminationReason?: string;
  claimVerificationStatus?: string;
  notCheckedReason?: string;
  reportUrlPresent?: boolean;
  outcomeKind?: string;
  deliverable?: string;
  runtimeKind?: string;
}

export interface StopObservedEvent {
  index: number;
  atMs: number;
  wireType: string;
  kind: StopEventKind;
  hasSseId: boolean;
  runId?: string;
  attempt?: number;
  liveOnly?: boolean;
  /** Draft token or answer body. Kept in memory only; redacted before any write. */
  text?: string;
  verificationPending?: boolean;
  answerReadable?: boolean;
  reviewOutcome?: string;
  reviewReason?: string;
  verdict?: StopVerdict;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseJson(data: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(data));
  } catch {
    return undefined;
  }
}

function draftFields(content: Record<string, unknown> | undefined): Pick<StopObservedEvent, 'runId' | 'attempt' | 'text'> {
  return {
    runId: str(content?.runId),
    attempt: typeof content?.attempt === 'number' ? content.attempt : undefined,
    text: str(content?.token),
  };
}

function reviewFields(content: Record<string, unknown> | undefined): Partial<StopObservedEvent> | undefined {
  if (content?.phase !== 'final_review') return undefined;
  if (content.stage === 'started') return {kind: 'review_started', answerReadable: content.answerReadable === true};
  if (content.stage === 'finished') {
    return {kind: 'review_finished', reviewOutcome: str(content.outcome), reviewReason: str(content.reason)};
  }
  return undefined;
}

function resultVerdict(result: Record<string, unknown> | undefined): StopVerdict {
  const claims = record(result?.claimVerificationResult);
  const intent = record(result?.turnIntent);
  const completion = record(result?.completion);
  return {
    ...(typeof result?.partial === 'boolean' ? {partial: result.partial} : {}),
    ...(str(result?.terminationReason) ? {terminationReason: str(result?.terminationReason)} : {}),
    ...(str(claims?.status) ? {claimVerificationStatus: str(claims?.status)} : {}),
    ...(str(claims?.notCheckedReason) ? {notCheckedReason: str(claims?.notCheckedReason)} : {}),
    ...(str(intent?.deliverable) ? {deliverable: str(intent?.deliverable)} : {}),
    ...(str(completion?.runtimeKind) ? {runtimeKind: str(completion?.runtimeKind)} : {}),
  };
}

/**
 * One frame of the agent route stream (`/api/agent/v1/runs/:runId/stream`):
 * `data` is `{type, data: content, runId, ...}`; drafts carry their own
 * `{runId, attempt}` inside the content.
 */
export function normalizeAgentFrame(frame: SseFrame, index: number, atMs: number): StopObservedEvent {
  const payload = parseJson(frame.data);
  const content = record(payload?.data);
  const base = {index, atMs, wireType: frame.event, hasSseId: frame.id !== undefined, runId: str(payload?.runId)};
  switch (frame.event) {
    case 'answer_token':
      return {...base, kind: 'draft_token', ...draftFields(content)};
    case 'answer_segment_reset':
      return {...base, kind: 'draft_reset', ...draftFields(content)};
    case 'conclusion':
      return content?.provisional === true
        ? {...base, kind: 'provisional', text: str(content.conclusion), verificationPending: content.verification === 'pending'}
        : {...base, kind: 'plain_conclusion', text: str(content?.conclusion)};
    case 'progress':
      return {...base, kind: 'other', ...reviewFields(content)};
    case 'analysis_completed':
      return {...base, kind: 'completed', text: str(content?.conclusion),
        verdict: {...resultVerdict(content), reportUrlPresent: Boolean(str(content?.reportUrl))}};
    case 'analysis_cancelled':
      return {...base, kind: 'cancelled'};
    case 'error':
      return {...base, kind: 'failed'};
    default:
      return {...base, kind: 'other'};
  }
}

/**
 * One frame of the conversation stream
 * (`/api/agent/v1/conversation/:sessionId/stream?runId=`): `data` is the
 * session event itself; runtime updates nest the StreamingUpdate in `update`.
 */
export function normalizeConversationFrame(frame: SseFrame, index: number, atMs: number): StopObservedEvent {
  const payload = parseJson(frame.data);
  const base = {index, atMs, wireType: frame.event, hasSseId: frame.id !== undefined, runId: str(payload?.runId),
    ...(payload?.liveOnly === true ? {liveOnly: true} : {})};
  switch (frame.event) {
    case 'runtime_update': {
      const update = record(payload?.update);
      const content = record(update?.content);
      const wireType = `runtime_update:${str(update?.type) ?? 'unknown'}`;
      if (update?.type === 'answer_token') return {...base, wireType, kind: 'draft_token', ...draftFields(content)};
      if (update?.type === 'answer_segment_reset') return {...base, wireType, kind: 'draft_reset', ...draftFields(content)};
      return {...base, wireType, kind: 'other', ...(update?.type === 'progress' ? reviewFields(content) : undefined)};
    }
    case 'provisional_answer':
      return {...base, kind: 'provisional', text: str(payload?.message), verificationPending: payload?.verification === 'pending'};
    case 'run_completed': {
      const outcome = record(payload?.outcome);
      const kind = str(outcome?.kind);
      return {...base, kind: kind === 'cancelled' ? 'cancelled' : 'completed', text: str(outcome?.message),
        verdict: {...resultVerdict(record(outcome?.finalResult)), ...(kind ? {outcomeKind: kind} : {})}};
    }
    case 'run_failed':
      return {...base, kind: 'failed'};
    default:
      return {...base, kind: 'other'};
  }
}

// ---------------------------------------------------------------------------
// Stop requests
// ---------------------------------------------------------------------------

export type StopTrigger = 'provisional' | 'first_draft' | 'first_progress' | 'after_first_stop';

export interface StopAttempt {
  order: 1 | 2;
  trigger: StopTrigger;
  /** Index of the event that triggered the stop (or of the last event seen when it was sent). */
  sentAfterEventIndex: number;
  respondedAfterEventIndex?: number;
  httpStatus?: number;
  requestError?: 'timeout' | 'network' | 'invalid_json';
  status?: string;
  outcome?: string;
  code?: string;
}

export type StopResponseClass = 'review_only' | 'full_cancel' | 'force_committed' | 'force_fallback'
  | 'already_terminal' | 'error';

/**
 * Agent route: `review_stop_requested`, `completed` + `committed` |
 * `review_not_finished`, `cancelled`, or 409 RUN_NOT_CANCELLABLE /
 * RUN_NOT_ACTIVE. Conversation: `review_stop_requested`, the settled outcome
 * kind, or 409 when the run is no longer active (code set by the CLI).
 */
export function classifyStopResponse(entry: StopEntry, attempt: StopAttempt): StopResponseClass {
  if (attempt.httpStatus === undefined) return 'error';
  if (attempt.httpStatus === 409) {
    return ['RUN_NOT_CANCELLABLE', 'RUN_NOT_ACTIVE', 'ACTIVE_RUN_NOT_FOUND'].includes(attempt.code ?? '')
      ? 'already_terminal' : 'error';
  }
  if (attempt.httpStatus !== 200) return 'error';
  if (attempt.status === 'review_stop_requested') return 'review_only';
  if (entry === 'agent') {
    if (attempt.status === 'completed' && attempt.outcome === 'committed') return 'force_committed';
    if (attempt.status === 'completed' && attempt.outcome === 'review_not_finished') return 'force_fallback';
    if (attempt.status === 'cancelled') return attempt.outcome === 'already_cancelled' ? 'already_terminal' : 'full_cancel';
    return 'error';
  }
  if (attempt.status === 'cancelled') return 'full_cancel';
  return ['answered', 'needs_user_input', 'recommend_full'].includes(attempt.status ?? '') ? 'force_committed' : 'error';
}

// ---------------------------------------------------------------------------
// Storage observation
// ---------------------------------------------------------------------------

export interface StoredTurnObservation {
  body?: string;
  partial?: boolean;
  terminationReason?: string;
  claimVerificationStatus?: string;
  completed?: boolean;
}

export interface StopStorageObservation {
  /** Session history / turn detail read for the exact session and run. */
  read: 'ok' | 'failed';
  sessionStatus?: string;
  /** Turns of this run (a fresh session holds only this run). */
  turns: StoredTurnObservation[];
  /** Conversation: assistant message bodies stored for this run. */
  assistantMessages?: string[];
  /** Agent route: the status endpoint still carries the report URL. */
  statusReportUrlPresent?: boolean;
  replay: {read: 'ok' | 'failed'; events: StopObservedEvent[]};
  /** Conversation only: history read the moment the provisional answer arrived. */
  midRunHistory?: {read: 'ok' | 'failed'; activeRunMatches?: boolean; assistantMessageForRun?: boolean};
}

export interface StopScenarioObservation {
  entry: StopEntry;
  scenario: StopScenario;
  runId: string;
  subscriptionGapMs?: number;
  events: StopObservedEvent[];
  streamEnd: 'closed' | 'terminal_grace' | 'timeout' | 'error';
  stops: StopAttempt[];
  storage?: StopStorageObservation;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

const TERMINAL_KINDS: ReadonlySet<StopEventKind> = new Set(['completed', 'cancelled', 'failed']);
const isDraft = (event: StopObservedEvent) => event.kind === 'draft_token' || event.kind === 'draft_reset';
const normalizeBody = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();

function check(id: string, status: StopCheckStatus, detail: string): StopCheckResult {
  return {id, status, detail};
}

function first(events: readonly StopObservedEvent[], kind: StopEventKind): StopObservedEvent | undefined {
  return events.find(event => event.kind === kind);
}

/** Text of every draft segment that a reset revoked (tokens of one attempt, then a reset). */
function revokedSegmentTexts(events: readonly StopObservedEvent[]): string[] {
  const revoked: string[] = [];
  let segment = '';
  for (const event of events) {
    if (event.kind === 'draft_token') segment += event.text ?? '';
    else if (event.kind === 'draft_reset') {
      if (segment.trim()) revoked.push(segment);
      segment = '';
    }
  }
  return revoked;
}

interface Context {
  obs: StopScenarioObservation;
  drafts: StopObservedEvent[];
  provisional?: StopObservedEvent;
  terminal?: StopObservedEvent;
  reviewDispatched: boolean;
  stopClasses: StopResponseClass[];
  storedBodies: string[];
}

function draftChecks({obs, drafts, provisional, terminal}: Context): StopCheckResult[] {
  const gap = obs.subscriptionGapMs === undefined ? 'unknown' : `${obs.subscriptionGapMs}ms`;
  if (drafts.length === 0) {
    const detail = `no draft event observed after subscription (subscription gap ${gap}); drafts are live-only`;
    return ['S1.draft_identity', 'S1.draft_attempt_order', 'S1.draft_reset_revokes', 'S1.draft_live_only',
      'S1.draft_before_answer'].map(id => check(id, 'not_exercised', detail));
  }
  const results: StopCheckResult[] = [];
  const badIdentity = drafts.filter(event => event.runId !== obs.runId ||
    !Number.isSafeInteger(event.attempt) || (event.attempt as number) < 0);
  results.push(badIdentity.length
    ? check('S1.draft_identity', 'fail', `${badIdentity.length}/${drafts.length} draft events lack this runId or a valid attempt`)
    : check('S1.draft_identity', 'pass', `${drafts.length} draft events carry runId and attempt (subscription gap ${gap})`));

  let previous = -1;
  let tokenAttempt: number | undefined;
  const orderViolations: string[] = [];
  for (const event of drafts) {
    const attempt = event.attempt ?? -1;
    if (attempt < previous) orderViolations.push(`#${event.index} attempt ${attempt} after ${previous}`);
    if (event.kind === 'draft_reset') {
      if (tokenAttempt !== undefined && attempt <= tokenAttempt) {
        orderViolations.push(`#${event.index} reset ${attempt} does not advance past token segment ${tokenAttempt}`);
      }
      tokenAttempt = undefined;
    } else {
      tokenAttempt = attempt;
    }
    previous = Math.max(previous, attempt);
  }
  results.push(orderViolations.length
    ? check('S1.draft_attempt_order', 'fail', orderViolations.slice(0, 5).join('; '))
    : check('S1.draft_attempt_order', 'pass', `attempts non-decreasing across ${drafts.length} draft events`));

  const resets = drafts.filter(event => event.kind === 'draft_reset');
  if (resets.length === 0) {
    results.push(check('S1.draft_reset_revokes', 'not_exercised', 'no answer_segment_reset occurred'));
  } else {
    const stale = resets.flatMap(reset => drafts.filter(event => event.index > reset.index &&
      event.kind === 'draft_token' && (event.attempt ?? -1) < (reset.attempt ?? 0)));
    results.push(stale.length
      ? check('S1.draft_reset_revokes', 'fail', `${stale.length} token(s) of a revoked segment arrived after its reset`)
      : check('S1.draft_reset_revokes', 'pass', `${resets.length} reset(s); no token of a revoked segment followed`));
  }

  const replayable = drafts.filter(event => event.hasSseId || (obs.entry === 'conversation' && event.liveOnly !== true));
  results.push(replayable.length
    ? check('S1.draft_live_only', 'fail', `${replayable.length} draft event(s) carried a replay id or lacked liveOnly`)
    : check('S1.draft_live_only', 'pass', 'every draft event was live-only (no SSE id)'));

  const answerIndex = Math.min(provisional?.index ?? Infinity,
    first(obs.events, 'plain_conclusion')?.index ?? Infinity, terminal?.index ?? Infinity);
  const late = drafts.filter(event => event.index > answerIndex);
  results.push(late.length
    ? check('S1.draft_before_answer', 'fail', `${late.length} draft event(s) arrived after the answer or terminal`)
    : check('S1.draft_before_answer', 'pass', 'all drafts preceded the provisional/final answer'));
  return results;
}

function reviewChecks(ctx: Context): StopCheckResult[] {
  const {obs, provisional, terminal, reviewDispatched} = ctx;
  const started = first(obs.events, 'review_started');
  const finished = first(obs.events, 'review_finished');
  const results: StopCheckResult[] = [];
  const cancelledBeforeReview = obs.scenario === 'stop_before_provisional' && ctx.stopClasses[0] === 'full_cancel';

  if (!reviewDispatched || cancelledBeforeReview) {
    results.push(check('S2.provisional_before_completion', 'not_exercised', cancelledBeforeReview
      ? 'run was fully cancelled before any review' : 'no review was dispatched (no provisional answer, no review start)'));
  } else if (!provisional) {
    results.push(started?.answerReadable
      ? check('S2.provisional_before_completion', 'fail', 'review progress says the answer is readable but no provisional answer arrived')
      : check('S2.provisional_before_completion', 'not_exercised', 'review started without a deliverable body (answerReadable false)'));
  } else {
    const provisionals = obs.events.filter(event => event.kind === 'provisional').length;
    const problems = [
      provisionals !== 1 ? `${provisionals} provisional answers` : '',
      !provisional.verificationPending ? 'provisional answer not marked verification pending' : '',
      !normalizeBody(provisional.text) ? 'provisional answer has an empty body' : '',
      terminal && terminal.index < provisional.index ? 'provisional answer arrived after the terminal event' : '',
      started && started.index < provisional.index ? 'review started before the provisional answer' : '',
      started && !started.answerReadable ? 'review progress after delivery lacks answerReadable' : '',
    ].filter(Boolean);
    results.push(problems.length
      ? check('S2.provisional_before_completion', 'fail', problems.join('; '))
      : check('S2.provisional_before_completion', 'pass', terminal
        ? `provisional #${provisional.index} precedes ${terminal.wireType} #${terminal.index}`
        : `provisional #${provisional.index} arrived; no terminal observed`));
  }

  if (reviewDispatched || terminal?.kind !== 'completed') {
    results.push(check('S2.no_review_branch', 'not_exercised', reviewDispatched
      ? 'a review was dispatched' : `run did not complete (${terminal?.wireType ?? 'no terminal'})`));
  } else {
    const plains = obs.events.filter(event => event.kind === 'plain_conclusion');
    const problems = [
      finished ? 'review progress present without a review start' : '',
      obs.entry === 'agent' && plains.length !== 1 ? `${plains.length} plain conclusions (expected 1)` : '',
      obs.entry === 'agent' && plains[0] && plains[0].index > terminal.index ? 'plain conclusion after completion' : '',
      obs.entry === 'conversation' && !normalizeBody(terminal.text) ? 'run_completed carries no answer body' : '',
    ].filter(Boolean);
    results.push(problems.length
      ? check('S2.no_review_branch', 'fail', problems.join('; '))
      : check('S2.no_review_branch', 'pass', obs.entry === 'agent'
        ? 'no provisional answer or review progress; plain conclusion preceded analysis_completed'
        : 'no provisional answer or review progress; run_completed carried the answer'));
  }
  return results;
}

function describeStop(attempt: StopAttempt | undefined, cls: StopResponseClass | undefined): string {
  if (!attempt) return 'not sent';
  const body = [attempt.status, attempt.outcome, attempt.code, attempt.requestError].filter(Boolean).join('/');
  return `stop#${attempt.order} after event #${attempt.sentAfterEventIndex} -> HTTP ${attempt.httpStatus ?? '-'} ${body} (${cls})`;
}

function stopAfterProvisionalChecks(ctx: Context): StopCheckResult[] {
  const {obs, terminal, stopClasses} = ctx;
  const [stop1, stop2] = obs.stops;
  const results: StopCheckResult[] = [];
  const stop1Text = describeStop(stop1, stopClasses[0]);
  if (!stop1) {
    results.push(check('S3.first_stop_review_only', 'not_exercised', 'no provisional answer arrived, so no stop was sent'));
  } else {
    switch (stopClasses[0]) {
      case 'review_only':
        results.push(terminal?.kind === 'completed'
          ? check('S3.first_stop_review_only', 'pass', `${stop1Text}; run still completed`)
          : check('S3.first_stop_review_only', 'fail', `${stop1Text}; run ended with ${terminal?.wireType ?? 'no terminal'}`));
        break;
      case 'already_terminal':
        results.push(check('S3.first_stop_review_only', 'legal_race', `${stop1Text}; the run had already committed`));
        break;
      case 'full_cancel':
        results.push(check('S3.first_stop_review_only', 'fail', `${stop1Text}; a stop after the provisional answer fully cancelled the run`));
        break;
      default:
        results.push(check('S3.first_stop_review_only', 'fail', stop1Text));
    }
  }

  if (obs.scenario === 'stop_after_provisional') {
    if (stopClasses[0] !== 'review_only') {
      results.push(check('S3.review_stop_verdict', 'not_exercised', 'first stop was not review-only'));
    } else {
      const finished = first(obs.events, 'review_finished');
      const verdict = terminal?.verdict;
      const claimText = `claim verification ${verdict?.claimVerificationStatus ?? 'unknown'}` +
        `${verdict?.deliverable ? `, deliverable ${verdict.deliverable}` : ''}`;
      if (finished?.reviewReason === 'cancelled_by_user' || verdict?.notCheckedReason === 'cancelled_by_user') {
        results.push(check('S3.review_stop_verdict', 'pass', `review ended cancelled_by_user; ${claimText}`));
      } else if (verdict?.terminationReason === 'review_not_finished') {
        results.push(check('S3.review_stop_verdict', 'not_exercised', 'the watchdog fallback committed the read body'));
      } else if (finished) {
        results.push(check('S3.review_stop_verdict', 'legal_race',
          `review finished on its own first (${finished.reviewOutcome ?? 'unknown'}${finished.reviewReason ? `/${finished.reviewReason}` : ''}); ${claimText}`));
      } else {
        results.push(check('S3.review_stop_verdict', 'fail', `no review finish and no cancelled_by_user verdict; ${claimText}`));
      }
    }
  }

  if (obs.scenario === 'force_after_provisional') {
    const stop2Text = describeStop(stop2, stopClasses[1]);
    if (!stop2) {
      results.push(check('S5.force_stop', 'not_exercised', `second stop not sent (${stop1Text})`));
    } else {
      const fallback = terminal?.verdict?.terminationReason === 'review_not_finished';
      switch (stopClasses[1]) {
        case 'force_committed':
          results.push(terminal?.kind === 'completed'
            ? check('S5.force_stop', 'pass', `${stop2Text}; branch ${fallback ? 'review_not_finished' : 'committed'}`)
            : check('S5.force_stop', 'fail', `${stop2Text}; but run ended with ${terminal?.wireType ?? 'no terminal'}`));
          break;
        case 'force_fallback':
          results.push(terminal?.kind === 'completed' && fallback
            ? check('S5.force_stop', 'pass', `${stop2Text}; branch review_not_finished`)
            : check('S5.force_stop', 'fail', `${stop2Text}; terminal is not a review_not_finished completion`));
          break;
        case 'full_cancel':
          results.push(terminal?.kind === 'cancelled'
            ? check('S5.force_stop', 'pass', `${stop2Text}; branch cancelled`)
            : check('S5.force_stop', 'fail', `${stop2Text}; but run ended with ${terminal?.wireType ?? 'no terminal'}`));
          break;
        case 'already_terminal':
          results.push(check('S5.force_stop', 'legal_race', `${stop2Text}; the run had already committed`));
          break;
        case 'review_only':
          results.push(check('S5.force_stop', 'fail', `${stop2Text}; a second stop must force, not stop the review again`));
          break;
        default:
          results.push(check('S5.force_stop', 'fail', stop2Text));
      }
    }
  }
  return results;
}

function stopBeforeProvisionalChecks(ctx: Context): StopCheckResult[] {
  const {obs, terminal, stopClasses, storedBodies} = ctx;
  const stop = obs.stops[0];
  const stopText = describeStop(stop, stopClasses[0]);
  if (!stop) {
    const detail = 'the trigger event did not arrive before the answer or terminal';
    return [check('S4.full_cancel_before_provisional', 'not_exercised', detail),
      check('S4.cancel_marker_only', 'not_exercised', detail)];
  }
  const results: StopCheckResult[] = [];
  const cls = stopClasses[0];
  if (cls === 'full_cancel') {
    const answered = obs.events.filter(event => event.index > stop.sentAfterEventIndex &&
      (event.kind === 'provisional' || event.kind === 'plain_conclusion' || event.kind === 'completed'));
    results.push(terminal?.kind === 'cancelled' && answered.length === 0
      ? check('S4.full_cancel_before_provisional', 'pass', `${stopText}; run ended cancelled`)
      : check('S4.full_cancel_before_provisional', 'fail',
        `${stopText}; terminal ${terminal?.wireType ?? 'none'}, ${answered.length} answer event(s) after the stop`));
  } else if (cls === 'review_only' || cls === 'already_terminal') {
    results.push(check('S4.full_cancel_before_provisional', 'legal_race', cls === 'review_only'
      ? `${stopText}; the provisional answer was delivered before the stop reached the server`
      : `${stopText}; the run had already committed`));
  } else {
    results.push(check('S4.full_cancel_before_provisional', 'fail', stopText));
  }

  if (cls !== 'full_cancel') {
    results.push(check('S4.cancel_marker_only', 'not_exercised', 'no full cancel took effect'));
    return results;
  }
  const storage = obs.storage;
  if (!storage || storage.read !== 'ok' || storage.replay.read !== 'ok') {
    results.push(check('S4.cancel_marker_only', 'fail', 'storage or replay could not be read after the cancel'));
    return results;
  }
  const replayAnswers = storage.replay.events.filter(event =>
    event.kind === 'provisional' || event.kind === 'plain_conclusion' || event.kind === 'completed');
  const replayCancelled = storage.replay.events.some(event => event.kind === 'cancelled');
  const problems = [
    storedBodies.length ? `${storedBodies.length} stored answer body(ies)` : '',
    replayAnswers.length ? `${replayAnswers.length} answer event(s) replayed` : '',
    !replayCancelled ? 'replay has no cancel marker' : '',
    obs.entry === 'agent' && storage.sessionStatus !== 'cancelled' ? `session status ${storage.sessionStatus ?? 'unknown'}` : '',
    obs.entry === 'conversation' && (storage.turns.length !== 1 || storage.turns[0].partial !== true)
      ? `${storage.turns.length} history turn(s) for the run, expected one partial marker` : '',
  ].filter(Boolean);
  results.push(problems.length
    ? check('S4.cancel_marker_only', 'fail', problems.join('; '))
    : check('S4.cancel_marker_only', 'pass', 'only the cancel marker is stored and replayed'));
  return results;
}

function storageChecks(ctx: Context): StopCheckResult[] {
  const {obs, drafts, terminal, stopClasses, storedBodies} = ctx;
  const storage = obs.storage;
  const results: StopCheckResult[] = [];
  const liveTerminals = obs.events.filter(event => TERMINAL_KINDS.has(event.kind));
  const storageOk = storage?.read === 'ok';
  const replayOk = storage?.replay.read === 'ok';
  const replayTerminals = storage?.replay.events.filter(event => TERMINAL_KINDS.has(event.kind)) ?? [];

  const committed = terminal?.kind === 'completed';
  const terminalProblems = [
    liveTerminals.length !== 1 ? `${liveTerminals.length} live terminal events` : '',
    !replayOk ? 'replay unreadable' : replayTerminals.length !== 1 ? `${replayTerminals.length} replayed terminal events` : '',
    !storageOk ? 'history unreadable' : '',
    storageOk && committed && storage!.turns.length !== 1 ? `${storage!.turns.length} stored turns (expected 1)` : '',
    storageOk && terminal?.kind === 'cancelled' && obs.entry === 'conversation' && storage!.turns.length !== 1
      ? `${storage!.turns.length} stored turns (expected the cancel marker)` : '',
  ].filter(Boolean);
  results.push(terminalProblems.length
    ? check('R.single_terminal', 'fail', terminalProblems.join('; '))
    : check('R.single_terminal', 'pass', `one ${terminal!.wireType} live and replayed; ${storage!.turns.length} stored turn(s)`));

  const replayDrafts = storage?.replay.events.filter(isDraft) ?? [];
  if (!replayOk) results.push(check('R.no_draft_replayed', 'fail', 'reconnect replay could not be read'));
  else if (replayDrafts.length) results.push(check('R.no_draft_replayed', 'fail', `${replayDrafts.length} draft event(s) replayed`));
  else if (drafts.length === 0) results.push(check('R.no_draft_replayed', 'not_exercised', 'no draft was observed live'));
  else results.push(check('R.no_draft_replayed', 'pass', `${drafts.length} live draft event(s); none replayed`));

  const revoked = revokedSegmentTexts(obs.events).map(normalizeBody).filter(text => text.length >= 16);
  if (revoked.length === 0) {
    results.push(check('R.no_revoked_draft_persisted', 'not_exercised', 'no revoked draft segment with text'));
  } else if (!storageOk) {
    results.push(check('R.no_revoked_draft_persisted', 'fail', 'history unreadable'));
  } else {
    const terminalBody = normalizeBody(terminal?.text);
    const leaked = revoked.filter(text => !terminalBody.includes(text) &&
      storedBodies.some(body => normalizeBody(body).includes(text)));
    results.push(leaked.length
      ? check('R.no_revoked_draft_persisted', 'fail', `${leaked.length} revoked draft segment(s) found in stored history`)
      : check('R.no_revoked_draft_persisted', 'pass', `${revoked.length} revoked segment(s); none stored`));
  }

  if (terminal?.kind !== 'completed') {
    results.push(check('R.persisted_body_is_verdict', 'not_exercised', 'run did not commit an answer'));
  } else if (!storageOk) {
    results.push(check('R.persisted_body_is_verdict', 'fail', 'history unreadable'));
  } else {
    const delivered = new Set([terminal.text, ctx.provisional?.text, first(obs.events, 'plain_conclusion')?.text]
      .map(normalizeBody).filter(Boolean));
    const mismatched = storedBodies.filter(body => !delivered.has(normalizeBody(body)));
    results.push(storedBodies.length !== 1 || mismatched.length
      ? check('R.persisted_body_is_verdict', 'fail',
        `${storedBodies.length} stored body(ies), ${mismatched.length} differ from the delivered answer`)
      : check('R.persisted_body_is_verdict', 'pass', 'the one stored body is the delivered answer'));
  }

  const fallbackTriggered = stopClasses.includes('force_fallback') ||
    terminal?.verdict?.terminationReason === 'review_not_finished';
  if (!fallbackTriggered) {
    results.push(check('R.watchdog_fallback', 'not_exercised', 'the review-stop watchdog did not fire'));
  } else {
    const verdict = terminal?.verdict;
    const turn = storage?.turns[0];
    const problems = [
      terminal?.kind !== 'completed' ? `terminal ${terminal?.wireType ?? 'none'}` : '',
      verdict?.partial !== true ? 'terminal not partial' : '',
      verdict?.terminationReason !== 'review_not_finished' ? `terminal reason ${verdict?.terminationReason ?? 'none'}` : '',
      verdict?.claimVerificationStatus !== undefined && verdict.claimVerificationStatus !== 'not_checked'
        ? `terminal claim verification ${verdict.claimVerificationStatus}` : '',
      !storageOk || !turn ? 'no stored turn' : '',
      turn && turn.partial !== true ? 'stored turn not partial' : '',
      turn && turn.terminationReason !== 'review_not_finished' ? `stored reason ${turn.terminationReason ?? 'none'}` : '',
      turn?.claimVerificationStatus !== undefined && turn.claimVerificationStatus !== 'not_checked'
        ? `stored claim verification ${turn.claimVerificationStatus}` : '',
    ].filter(Boolean);
    results.push(problems.length
      ? check('R.watchdog_fallback', 'fail', problems.join('; '))
      : check('R.watchdog_fallback', 'pass', 'fallback turn is partial / review_not_finished / not_checked'));
  }

  if (obs.entry === 'agent') {
    if (terminal?.kind !== 'completed') {
      results.push(check('R.report_metadata', 'not_exercised', 'run did not commit'));
    } else {
      const problems = [
        !terminal.verdict?.reportUrlPresent ? 'analysis_completed has no reportUrl' : '',
        !storageOk || !storage!.statusReportUrlPresent ? 'status result has no reportUrl' : '',
      ].filter(Boolean);
      results.push(problems.length
        ? check('R.report_metadata', 'fail', problems.join('; '))
        : check('R.report_metadata', 'pass', 'report URL kept on analysis_completed and the status result'));
    }
  } else {
    const mid = storage?.midRunHistory;
    if (!mid) {
      results.push(check('R.conversation_store_verdict_only', 'not_exercised', 'history was not read at the provisional answer'));
    } else if (mid.read !== 'ok') {
      results.push(check('R.conversation_store_verdict_only', 'fail', 'history read at the provisional answer failed'));
    } else if (!mid.activeRunMatches) {
      results.push(check('R.conversation_store_verdict_only', 'legal_race', 'the run had already committed when history was read'));
    } else {
      results.push(mid.assistantMessageForRun
        ? check('R.conversation_store_verdict_only', 'fail', 'an assistant message was stored before the verdict')
        : check('R.conversation_store_verdict_only', 'pass', 'no assistant message stored while the review ran'));
    }
  }
  return results;
}

export function evaluateStopScenario(obs: StopScenarioObservation): StopCheckResult[] {
  const events = obs.events.filter(event => !event.runId || event.runId === obs.runId || isDraft(event));
  const scoped = {...obs, events};
  const provisional = first(events, 'provisional');
  const ctx: Context = {
    obs: scoped,
    drafts: events.filter(isDraft),
    provisional,
    terminal: events.find(event => TERMINAL_KINDS.has(event.kind)),
    reviewDispatched: Boolean(provisional || first(events, 'review_started')),
    stopClasses: obs.stops.map(attempt => classifyStopResponse(obs.entry, attempt)),
    storedBodies: obs.storage?.read === 'ok'
      ? [...obs.storage.turns.map(turn => turn.body ?? ''), ...(obs.storage.assistantMessages ?? [])].filter(body => body.trim())
      : [],
  };
  return [
    ...draftChecks(ctx),
    ...reviewChecks(ctx),
    ...(obs.scenario === 'stop_after_provisional' || obs.scenario === 'force_after_provisional'
      ? stopAfterProvisionalChecks(ctx) : []),
    ...(obs.scenario === 'stop_before_provisional' ? stopBeforeProvisionalChecks(ctx) : []),
    ...storageChecks(ctx),
  ];
}

export function summarizeStopChecks(results: readonly StopCheckResult[]): Record<StopCheckStatus, number> & {passed: boolean} {
  const counts: Record<StopCheckStatus, number> = {pass: 0, legal_race: 0, not_exercised: 0, fail: 0};
  for (const result of results) counts[result.status] += 1;
  return {...counts, passed: counts.fail === 0};
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** Length and short digest instead of text: evidence never carries answer or draft bodies. */
function redactText(text: string | undefined): {chars: number; sha256: string} | undefined {
  if (text === undefined) return undefined;
  return {chars: text.length, sha256: createHash('sha256').update(text).digest('hex').slice(0, 16)};
}

function redactEvents(events: readonly StopObservedEvent[]) {
  return events.map(({text, ...event}) => ({...event, ...(text !== undefined ? {text: redactText(text)} : {})}));
}

export function redactStopObservation(obs: StopScenarioObservation) {
  const storage = obs.storage;
  return {
    ...obs,
    events: redactEvents(obs.events),
    ...(storage ? {storage: {
      ...storage,
      turns: storage.turns.map(({body, ...turn}) => ({...turn, body: redactText(body)})),
      ...(storage.assistantMessages ? {assistantMessages: storage.assistantMessages.map(redactText)} : {}),
      replay: {...storage.replay, events: redactEvents(storage.replay.events)},
    }} : {}),
  };
}
