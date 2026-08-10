// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AssistantSessionStatus, ManagedAssistantSession} from './assistantApplicationService';
import {AssistantApplicationService} from './assistantApplicationService';
import type {AnalysisOptions} from '../../agent/core/orchestratorTypes';
import type {AgentRuntimeKind} from '../../services/providerManager';
import type {
  ConversationEvidenceRef,
  ConversationMessage,
  ConversationRuntimeOutcome,
  ConversationTraceContext,
  FullAnalysisHandoff,
} from '../contracts/conversationContract';

export type {
  ConversationEvidenceRef,
  ConversationMessage,
  ConversationRuntimeOutcome,
  ConversationTraceContext,
  FullAnalysisHandoff,
} from '../contracts/conversationContract';

export interface ConversationRuntimeInput {
  sessionId: string;
  runId: string;
  query: string;
  history: ConversationMessage[];
  traceContext: ConversationTraceContext;
  selectionContext?: AnalysisOptions['selectionContext'];
  onUpdate?(update: unknown): void;
}

export interface ConversationRuntimeAdapter {
  run(input: ConversationRuntimeInput): Promise<ConversationRuntimeOutcome>;
  cancel(sessionId: string, runId: string): Promise<void>;
  dispose?(): void | Promise<void>;
}

type ConversationSessionEventPayload =
  | {type: 'run_started'; sessionId: string; runId: string}
  | {type: 'runtime_update'; sessionId: string; runId: string; update: unknown}
  | {type: 'run_completed'; sessionId: string; runId: string; outcome: ConversationRuntimeOutcome}
  | {type: 'run_failed'; sessionId: string; runId: string; error: string};

export type ConversationSessionEvent = ConversationSessionEventPayload & {seqId: number};

export interface ConversationRun {
  runId: string;
  query: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  startedAt: number;
  completedAt?: number;
  outcome?: ConversationRuntimeOutcome;
  error?: string;
  completion: Promise<ConversationRuntimeOutcome>;
  events: ConversationSessionEvent[];
  lifecycleSettled?: boolean;
}

export interface ConversationSession extends ManagedAssistantSession {
  runtime: ConversationRuntimeAdapter;
  history: ConversationMessage[];
  traceContext: ConversationTraceContext;
  evidence: ConversationEvidenceRef[];
  runs: ConversationRun[];
  activeRun?: ConversationRun;
  pendingQuestion?: string;
  recommendedFullAnalysis?: boolean;
  fullAnalysisHandoff?: FullAnalysisHandoff;
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
  providerId?: string | null;
  providerFollowsActive?: boolean;
  runtimeKind?: AgentRuntimeKind;
  providerSnapshotHash?: string;
  analysisContextFingerprint?: string;
  outputLanguage?: AnalysisOptions['outputLanguage'];
  codeAwareMode?: AnalysisOptions['codeAwareMode'];
  codebaseIds?: string[];
  knowledgeSourceIds?: string[];
}

export interface StartConversationTurnInput {
  query: string;
  sessionId?: string;
  traceContext?: ConversationTraceContext;
  owner?: {tenantId: string; workspaceId: string; userId: string};
  providerId?: string | null;
  providerFollowsActive?: boolean;
  runtimeKind?: AgentRuntimeKind;
  providerSnapshotHash?: string;
  runtimeOptions?: Omit<AnalysisOptions, 'analysisMode' | 'assistantSurface' | 'runId'>;
  analysisContextFingerprint?: string;
}

export interface ConversationTurnReceipt {
  sessionId: string;
  runId: string;
  isNewSession: boolean;
  completion: Promise<ConversationRuntimeOutcome>;
}

interface ConversationSessionServiceDeps {
  createRuntime(input: StartConversationTurnInput): ConversationRuntimeAdapter;
  createId?(prefix: 'conversation' | 'run'): string;
  now?(): number;
  cancelSettleTimeoutMs?: number;
  onRunStarted?(session: ConversationSession, run: ConversationRun): void;
  onRunSettled?(session: ConversationSession, run: ConversationRun): void;
}

function defaultCreateId(prefix: 'conversation' | 'run'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const MAX_REPLAY_EVENTS_PER_RUN = 512;

function normalizeTraceContext(
  context: ConversationTraceContext | undefined,
): ConversationTraceContext {
  if (context?.kind !== 'attached') return {kind: 'none'};
  const traceId = context.traceId.trim();
  if (!traceId) throw new Error('Attached conversation traceId must not be empty');
  return {kind: 'attached', traceId};
}

function traceContextsEqual(
  left: ConversationTraceContext,
  right: ConversationTraceContext,
): boolean {
  return left.kind === right.kind &&
    (left.kind === 'none' || (
      right.kind === 'attached' && left.traceId === right.traceId
    ));
}

function appendUniqueEvidence(
  target: ConversationEvidenceRef[],
  incoming: ConversationEvidenceRef[] | undefined,
): void {
  if (!incoming?.length) return;
  const knownIds = new Set(target.map((item) => item.id));
  for (const item of incoming) {
    if (!item.id || knownIds.has(item.id)) continue;
    target.push(item);
    knownIds.add(item.id);
  }
}

/**
 * Owns conversation-only lifecycle independently from trace analysis sessions.
 * A clarification outcome ends the physical run and leaves only logical
 * continuity in the session history.
 */
export class ConversationSessionService {
  private readonly sessions = new AssistantApplicationService<ConversationSession>();
  private readonly createRuntime: (
    input: StartConversationTurnInput,
  ) => ConversationRuntimeAdapter;
  private readonly createId: (prefix: 'conversation' | 'run') => string;
  private readonly now: () => number;
  private readonly cancelSettleTimeoutMs: number;
  private readonly onRunStarted?: ConversationSessionServiceDeps['onRunStarted'];
  private readonly onRunSettled?: ConversationSessionServiceDeps['onRunSettled'];
  private readonly listeners = new Map<string, Set<(event: ConversationSessionEvent) => void>>();
  private nextEventSeqId = 0;

  constructor(deps: ConversationSessionServiceDeps) {
    this.createRuntime = deps.createRuntime;
    this.createId = deps.createId ?? defaultCreateId;
    this.now = deps.now ?? Date.now;
    this.cancelSettleTimeoutMs = deps.cancelSettleTimeoutMs ?? 120_000;
    this.onRunStarted = deps.onRunStarted;
    this.onRunSettled = deps.onRunSettled;
  }

  getSession(sessionId: string): ConversationSession | undefined {
    return this.sessions.getSession(sessionId);
  }

  subscribe(
    sessionId: string,
    listener: (event: ConversationSessionEvent) => void,
  ): () => void {
    const listeners = this.listeners.get(sessionId) ?? new Set();
    listeners.add(listener);
    this.listeners.set(sessionId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(sessionId);
    };
  }

  startTurn(input: StartConversationTurnInput): ConversationTurnReceipt {
    const query = input.query.trim();
    if (!query) throw new Error('Conversation query is required');

    let session = input.sessionId
      ? this.sessions.getSession(input.sessionId)
      : undefined;
    const isNewSession = !session;
    if (input.sessionId && !session) {
      throw new Error(`Conversation session not found: ${input.sessionId}`);
    }
    if (!session) {
      const sessionId = this.createId('conversation');
      const createdAt = this.now();
      session = {
        sessionId,
        status: 'pending',
        createdAt,
        lastActivityAt: createdAt,
        sseClients: [],
        runtime: this.createRuntime(input),
        history: [],
        traceContext: normalizeTraceContext(input.traceContext),
        evidence: [],
        runs: [],
        ...(input.owner ?? {}),
        ...(input.providerId !== undefined ? {providerId: input.providerId} : {}),
        ...(input.providerFollowsActive !== undefined
          ? {providerFollowsActive: input.providerFollowsActive}
          : {}),
        ...(input.runtimeKind ? {runtimeKind: input.runtimeKind} : {}),
        ...(input.providerSnapshotHash
          ? {providerSnapshotHash: input.providerSnapshotHash}
          : {}),
        ...(input.analysisContextFingerprint
          ? {analysisContextFingerprint: input.analysisContextFingerprint}
          : {}),
        ...(input.runtimeOptions?.outputLanguage
          ? {outputLanguage: input.runtimeOptions.outputLanguage}
          : {}),
        ...(input.runtimeOptions?.codeAwareMode
          ? {codeAwareMode: input.runtimeOptions.codeAwareMode}
          : {}),
        ...(input.runtimeOptions?.codebaseIds?.length
          ? {codebaseIds: [...input.runtimeOptions.codebaseIds]}
          : {}),
        ...(input.runtimeOptions?.knowledgeSourceIds?.length
          ? {knowledgeSourceIds: [...input.runtimeOptions.knowledgeSourceIds]}
          : {}),
      };
      this.sessions.setSession(sessionId, session);
    }
    const requestedTraceContext = input.traceContext
      ? normalizeTraceContext(input.traceContext)
      : session.traceContext;
    if (!isNewSession && !traceContextsEqual(session.traceContext, requestedTraceContext)) {
      throw new Error('Start a new conversation after changing the attached Trace');
    }
    if (
      !isNewSession &&
      input.providerId !== undefined &&
      session.providerId !== input.providerId
    ) {
      throw new Error('Start a new conversation after changing the AI provider');
    }
    if (
      !isNewSession &&
      input.providerSnapshotHash &&
      session.providerSnapshotHash &&
      session.providerSnapshotHash !== input.providerSnapshotHash
    ) {
      throw new Error('Start a new conversation after changing the AI provider configuration');
    }
    if (session.activeRun) {
      throw new Error(`Conversation already in progress for session ${session.sessionId}`);
    }

    session.traceContext = requestedTraceContext;
    const previousStatus = session.status;
    const previousLastActivityAt = session.lastActivityAt;
    const previousPendingQuestion = session.pendingQuestion;
    const previousRecommendedFullAnalysis = session.recommendedFullAnalysis;
    const previousFullAnalysisHandoff = session.fullAnalysisHandoff;
    session.pendingQuestion = undefined;
    session.recommendedFullAnalysis = false;
    session.fullAnalysisHandoff = undefined;
    session.status = 'running';
    session.lastActivityAt = this.now();

    const runId = this.createId('run');
    const runtimeInput: ConversationRuntimeInput = {
      sessionId: session.sessionId,
      runId,
      query,
      history: session.history.map((message) => ({...message})),
      traceContext: session.traceContext,
      selectionContext: input.runtimeOptions?.selectionContext,
      onUpdate: (update) => this.publish(session!.sessionId, {
        type: 'runtime_update',
        sessionId: session!.sessionId,
        runId,
        update,
      }),
    };
    const run: ConversationRun = {
      runId,
      query,
      status: 'running',
      startedAt: this.now(),
      completion: Promise.resolve({kind: 'cancelled', message: ''}),
      events: [],
    };
    session.activeRun = run;
    session.runs.push(run);
    try {
      this.onRunStarted?.(session, run);
    } catch (error) {
      session.activeRun = undefined;
      session.runs.pop();
      if (isNewSession) {
        this.sessions.deleteSession(session.sessionId);
      } else {
        session.status = previousStatus;
        session.lastActivityAt = previousLastActivityAt;
        session.pendingQuestion = previousPendingQuestion;
        session.recommendedFullAnalysis = previousRecommendedFullAnalysis;
        session.fullAnalysisHandoff = previousFullAnalysisHandoff;
      }
      throw error;
    }
    this.publish(session.sessionId, {
      type: 'run_started',
      sessionId: session.sessionId,
      runId,
    });
    session.history.push({role: 'user', content: query});

    let runtimeCompletion: Promise<ConversationRuntimeOutcome>;
    try {
      runtimeCompletion = session.runtime.run(runtimeInput);
    } catch (error) {
      runtimeCompletion = Promise.reject(error);
    }
    const completion = runtimeCompletion
      .then((outcome) => {
        this.completeRun(session!, run, outcome);
        this.settleRun(session!, run);
        this.publish(session!.sessionId, {
          type: 'run_completed',
          sessionId: session!.sessionId,
          runId,
          outcome,
        });
        return outcome;
      })
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        run.status = 'failed';
        run.error = message;
        run.completedAt = this.now();
        session!.status = 'failed';
        session!.error = message;
        session!.lastActivityAt = run.completedAt;
        if (session!.activeRun?.runId === run.runId) {
          session!.activeRun = undefined;
        }
        this.settleRun(session!, run);
        this.publish(session!.sessionId, {
          type: 'run_failed',
          sessionId: session!.sessionId,
          runId,
          error: message,
        });
        throw error;
      });
    run.completion = completion;

    return {
      sessionId: session.sessionId,
      runId,
      isNewSession,
      completion,
    };
  }

  async steer(input: Required<Pick<StartConversationTurnInput, 'sessionId' | 'query'>> & {
    traceContext?: ConversationTraceContext;
  }): Promise<ConversationTurnReceipt> {
    const session = this.sessions.getSession(input.sessionId);
    if (!session) throw new Error(`Conversation session not found: ${input.sessionId}`);
    if (session.activeRun) {
      await this.cancelRun(session.sessionId, session.activeRun.runId);
    }
    return this.startTurn(input);
  }

  async cancelRun(sessionId: string, runId: string): Promise<ConversationRuntimeOutcome> {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw new Error(`Conversation session not found: ${sessionId}`);
    const run = session.activeRun;
    if (!run || run.runId !== runId) {
      throw new Error(`Active conversation run not found: ${runId}`);
    }
    await session.runtime.cancel(sessionId, runId);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        run.completion,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`Conversation cancellation did not settle within ${this.cancelSettleTimeoutMs}ms`)),
            this.cancelSettleTimeoutMs,
          );
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  buildFullAnalysisHandoff(sessionId: string): FullAnalysisHandoff | undefined {
    const handoff = this.sessions.getSession(sessionId)?.fullAnalysisHandoff;
    return handoff
      ? {
          ...handoff,
          assumptions: [...handoff.assumptions],
          evidence: handoff.evidence.map((item) => ({...item})),
        }
      : undefined;
  }

  cleanupIdleSessions(options: {
    terminalMaxIdleMs: number;
    nonTerminalMaxIdleMs: number;
    now?: number;
  }): string[] {
    return this.sessions.cleanupIdleSessions({
      ...options,
      onCleanup: (sessionId, session) => {
        for (const client of session.sseClients) {
          try {
            client.end();
          } catch {
            // Ignore sockets that already closed while the cleanup sweep ran.
          }
        }
        const activeRun = session.activeRun;
        if (activeRun && !activeRun.lifecycleSettled) {
          activeRun.status = 'cancelled';
          activeRun.completedAt = options.now ?? this.now();
          session.status = 'cancelled';
          session.activeRun = undefined;
          this.settleRun(session, activeRun);
        }
        const cancel = activeRun
          ? session.runtime.cancel(sessionId, activeRun.runId)
          : Promise.resolve();
        void Promise.resolve(cancel)
          .catch(() => undefined)
          .finally(() => Promise.resolve(session.runtime.dispose?.()).catch(() => undefined));
        this.listeners.delete(sessionId);
      },
    });
  }

  private completeRun(
    session: ConversationSession,
    run: ConversationRun,
    outcome: ConversationRuntimeOutcome,
  ): void {
    const completedAt = this.now();
    run.outcome = outcome;
    run.completedAt = completedAt;
    run.status = outcome.kind === 'cancelled' ? 'cancelled' : 'completed';
    if (outcome.message.trim()) {
      session.history.push({role: 'assistant', content: outcome.message});
    }
    appendUniqueEvidence(session.evidence, outcome.evidence);
    session.lastActivityAt = completedAt;
    session.error = undefined;

    let status: AssistantSessionStatus = 'completed';
    if (outcome.kind === 'needs_user_input') {
      status = 'awaiting_user';
      session.pendingQuestion = outcome.question;
    } else if (outcome.kind === 'recommend_full') {
      session.recommendedFullAnalysis = true;
      session.fullAnalysisHandoff = outcome.handoff;
      appendUniqueEvidence(session.evidence, outcome.handoff.evidence);
    } else if (outcome.kind === 'cancelled') {
      status = 'cancelled';
    }
    session.status = status;
    if (session.activeRun?.runId === run.runId) {
      session.activeRun = undefined;
    }
  }

  private settleRun(session: ConversationSession, run: ConversationRun): void {
    if (run.lifecycleSettled) return;
    run.lifecycleSettled = true;
    try {
      this.onRunSettled?.(session, run);
    } catch {
      // Lifecycle persistence is best-effort after the runtime has settled.
    }
  }

  private publish(sessionId: string, payload: ConversationSessionEventPayload): void {
    const event: ConversationSessionEvent = {
      ...payload,
      seqId: ++this.nextEventSeqId,
    };
    const run = this.sessions.getSession(sessionId)?.runs.find(
      candidate => candidate.runId === event.runId,
    );
    if (run) {
      run.events.push(event);
      if (run.events.length > MAX_REPLAY_EVENTS_PER_RUN) run.events.shift();
    }
    for (const listener of this.listeners.get(sessionId) ?? []) listener(event);
  }
}
