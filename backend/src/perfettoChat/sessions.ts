// SPDX-License-Identifier: AGPL-3.0-or-later

import {createHash, randomUUID} from 'node:crypto';
import type {RequestContext} from '../middleware/auth';
import {chatProfileRevision, loadChatProfile, type ChatProfile} from './config';
import {runPiTurn, type ChatExchange} from './piSession';
import {isSkillRunnerAvailable, runStandardSkill} from './runner';
import {isTraceTimestamp, loadSkillBundle, loadSkillRuntime} from './skillBundle';
import {makeChatTools, type ProbeResult} from './tools';
import {prepareTraceInput, resolveChatTrace, selectionWithinBounds, type Selection, type TraceAsset} from './trace';

const TTL = 30 * 60_000;
const TURN_TIMEOUT = 180_000;
const MAX_ANSWER = 32_000;
const MAX_TURNS = 100;
const MAX_ACTIVE = 4;

type AdmissionCode = 'CAPACITY_EXCEEDED' | 'TURN_ALREADY_SUBMITTED' | 'TURN_ID_CONFLICT' | 'TURN_ALREADY_ACTIVE';

export class ChatAdmissionError extends Error {
  constructor(readonly code: AdmissionCode) {
    super(code);
  }
}

type EventBody =
  | {type: 'turn_started'}
  | {type: 'answer_delta'; delta: string}
  | {type: 'tool_status'; tool: string}
  | ({type: 'trace_reference'} & import('./tools').TraceReference)
  | {type: 'turn_completed'; answer: string}
  | {type: 'turn_cancelled'}
  | {type: 'turn_failed'; code: string};

interface ChatSession {
  id: string;
  scope: string;
  profileKey: string;
  asset?: TraceAsset;
  probe?: ProbeResult;
  history: ChatExchange[];
  turns: Map<string, string>;
  expiresAt: number;
  active?: TurnRecord;
  closed?: boolean;
}
interface TurnRecord {
  id: string;
  controller: AbortController;
  settled: Promise<void>;
  settle(): void;
}

const sessions = new Map<string, ChatSession>();
let activeTurns = 0;

function scopeKey(context: RequestContext): string {
  return JSON.stringify([context.authType, context.tenantId, context.workspaceId, context.userId]);
}


export async function openChatSession(
  context: RequestContext, profile: ChatProfile, traceId?: string,
): Promise<string> {
  for (const [id, session] of sessions) {
    if (!session.active && session.expiresAt <= Date.now()) sessions.delete(id);
  }
  const asset = traceId ? await resolveChatTrace(traceId, context) : undefined;
  if (sessions.size >= 24) throw new ChatAdmissionError('CAPACITY_EXCEEDED');
  const id = randomUUID();
  sessions.set(id, {id, scope: scopeKey(context), profileKey: chatProfileRevision(profile),
    asset, history: [], turns: new Map(), expiresAt: Date.now() + TTL});
  return id;
}

export function findChatSession(context: RequestContext, id: string): ChatSession | undefined {
  const session = sessions.get(id);
  if (!session || session.scope !== scopeKey(context) || session.closed) return undefined;
  if (!session.active && session.expiresAt <= Date.now()) {
    sessions.delete(id);
    return undefined;
  }
  return session;
}

export function closeChatSession(session: ChatSession): void {
  session.closed = true;
  session.active?.controller.abort('CANCELLED');
  if (!session.active) sessions.delete(session.id);
}

export function stopChatTurn(session: ChatSession, id: string): void {
  if (session.active?.id === id) session.active.controller.abort('CANCELLED');
}

export function beginChatTurn(
  session: ChatSession, id: string, text: string, selection: Selection | undefined,
): TurnRecord {
  const fingerprint = createHash('sha256').update(JSON.stringify([text, selection])).digest('hex');
  const previous = session.turns.get(id);
  if (previous) throw new ChatAdmissionError(previous === fingerprint ? 'TURN_ALREADY_SUBMITTED' : 'TURN_ID_CONFLICT');
  if (session.active) throw new ChatAdmissionError('TURN_ALREADY_ACTIVE');
  if (session.turns.size >= MAX_TURNS || activeTurns >= MAX_ACTIVE) throw new ChatAdmissionError('CAPACITY_EXCEEDED');
  let settle!: () => void;
  const settled = new Promise<void>(resolve => { settle = resolve; });
  const turn = {id, controller: new AbortController(), settled, settle};
  session.active = turn;
  session.turns.set(id, fingerprint);
  activeTurns++;
  return turn;
}

export async function executeChatTurn(
  context: RequestContext, session: ChatSession, turn: TurnRecord, profile: ChatProfile,
  text: string, selection: Selection | undefined, emit: (event: EventBody) => void,
): Promise<void> {
  const {signal} = turn.controller;
  const timer = setTimeout(() => turn.controller.abort('TURN_TIMED_OUT'), TURN_TIMEOUT);
  timer.unref();
  let terminal: EventBody = {type: 'turn_failed', code: 'MODEL_RESPONSE_FAILED'};
  let input: Awaited<ReturnType<typeof prepareTraceInput>> | undefined;

  const authorize = async () => {
    signal.throwIfAborted();
    const asset = session.asset;
    if (asset) {
      let identity: string | undefined;
      try { identity = (await resolveChatTrace(asset.id, context)).identity; } catch { /* revoked */ }
      if (identity !== asset.identity) turn.controller.abort('TRACE_UNAVAILABLE');
    }
    const latest = loadChatProfile();
    if (session.closed || !latest || chatProfileRevision(latest) !== session.profileKey) {
      turn.controller.abort('SESSION_CONFIGURATION_CHANGED');
    }
    signal.throwIfAborted();
  };

  try {
    emit({type: 'turn_started'});
    await authorize();
    const bundle = await loadSkillBundle();
    let getTrace: Parameters<typeof makeChatTools>[0]['getTrace'];
    if (session.asset) {
      const runtime = await loadSkillRuntime(bundle);
      if (!runtime) throw new Error('SKILL_RUNTIME_UNAVAILABLE');
      const asset = session.asset;
      let preparation: ReturnType<NonNullable<typeof getTrace>> | undefined;
      getTrace = () => preparation ??= (async () => {
        await authorize();
        input = await prepareTraceInput(asset);
        await authorize();
        if (!session.probe) {
          const result = await runStandardSkill(runtime, input.file, 'probe', '', {}, signal) as ProbeResult;
          if (!result.bounds || !isTraceTimestamp(result.bounds.start_ns) ||
              !isTraceTimestamp(result.bounds.end_ns) || BigInt(result.bounds.start_ns) > BigInt(result.bounds.end_ns)) {
            throw new Error('TRACE_BOUNDS_UNAVAILABLE');
          }
          session.probe = result;
        }
        if (selection && !selectionWithinBounds(selection, session.probe.bounds)) {
          turn.controller.abort('INVALID_SELECTION');
          signal.throwIfAborted();
        }
        return {id: asset.id, file: input.file, runtime, probe: session.probe};
      })();
    }
    const focus = selection ? JSON.stringify({
      kind: selection.kind, startNs: selection.startNs, endNs: selection.endNs, trackHints: selection.trackHints,
    }) : undefined;
    const modelContext = focus
      ? `A local trace is attached. The user’s Viewer focus hint (absolute trace ns) is ${focus}.
Track labels are hints, not identities. Use only observed standard-tool evidence. If a workflow
takes time parameters, use these bounds for the selected interval unless more context is needed.`
      : 'The user has not attached a trace. Do not claim to have queried their trace.';
    let deltaLength = 0;
    const answer = await runPiTurn({
      profile, history: session.history, skill: bundle, context: modelContext, text, signal,
      canDispatch: authorize,
      tools: makeChatTools({bundle, getTrace, signal, authorize,
        onTool: tool => emit({type: 'tool_status', tool}),
        onReference: reference => emit({type: 'trace_reference', ...reference}),
      }),
      onDelta: delta => {
        if (signal.aborted) return;
        deltaLength += delta.length;
        if (deltaLength > MAX_ANSWER) {
          turn.controller.abort('MODEL_RESPONSE_TOO_LARGE');
          return;
        }
        emit({type: 'answer_delta', delta});
      },
    });
    await authorize();
    session.history.push({
      user: focus ? `${text}\n[Viewer focus for this previous question: ${focus}]` : text,
      answer: answer.slice(0, 8000),
    });
    if (session.history.length > 4) session.history.shift();
    terminal = {type: 'turn_completed', answer};
  } catch (error) {
    const reason = signal.aborted ? signal.reason : error instanceof Error ? error.message : undefined;
    const publicErrors = ['TRACE_UNAVAILABLE', 'TRACE_BOUNDS_UNAVAILABLE', 'INVALID_SELECTION',
      'SESSION_CONFIGURATION_CHANGED', 'SKILL_RUNTIME_UNAVAILABLE', 'SKILL_EXECUTION_FAILED',
      'TURN_TIMED_OUT', 'CAPACITY_EXCEEDED', 'MODEL_RESPONSE_TOO_LARGE', 'MODEL_RATE_LIMITED', 'MODEL_AUTH_FAILED'];
    terminal = reason === 'CANCELLED' ? {type: 'turn_cancelled'}
      : {type: 'turn_failed', code: typeof reason === 'string' && publicErrors.includes(reason)
        ? reason : 'MODEL_RESPONSE_FAILED'};
  } finally {
    if (input && !isSkillRunnerAvailable()) {
      closeChatSession(session);
      terminal = {type: 'turn_failed', code: 'SKILL_RUNTIME_UNAVAILABLE'};
    }
    try {
      await input?.dispose();
    } catch {
      closeChatSession(session);
      terminal = {type: 'turn_failed', code: 'TRACE_CLEANUP_FAILED'};
    }
    clearTimeout(timer);
    activeTurns--;
    session.active = undefined;
    if (session.closed) sessions.delete(session.id);
    else session.expiresAt = Date.now() + TTL;
    try { emit(terminal); } finally { turn.settle(); }
  }
}

export async function closeAllChatSessions(): Promise<void> {
  const pending = [];
  for (const session of sessions.values()) {
    if (session.active) pending.push(session.active.settled);
    closeChatSession(session);
  }
  await Promise.all(pending);
}
