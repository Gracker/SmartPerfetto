// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {AssistantSessionStatus, ManagedAssistantSession} from './assistantApplicationService';
import {AssistantApplicationService} from './assistantApplicationService';
import type {AnalysisOptions} from '../../agent/core/orchestratorTypes';
import {toAnalysisHistoryTurn, type AnalysisHistoryTurn} from '../../agentRuntime/analysisHistory';
import type {ConversationSessionDescriptor} from '../../services/conversationSessionStore';
import type {AgentRuntimeKind} from '../../services/providerManager';
import type {
  ConversationEvidenceRef,
  ConversationMessage,
  ConversationRuntimeOutcome,
  ConversationTraceContext,
  FullAnalysisHandoff,
} from '../contracts/conversationContract';
import {assertCurrentAnalysisContextAuthorization} from '../../services/resolvedAnalysisContext';
import {runAnalysisSelection} from '../../services/effectiveAnalysisSelection';
import {
  privateContextRestrictsAudience,
  resolveAnalysisPrivateContext,
  type AnalysisPrivateContextMarker,
} from '../../services/security/analysisPrivateContext';
import {resolveKnowledgeScope} from '../../services/scopedKnowledgeStore';
import {PublicRequestError} from '../../utils/publicRequestError';
import {
  buildReviewNotFinishedResult,
  mayPersistUnverifiedBody,
  resolveReviewStopWatchdogMs,
  ReviewStopController,
  settlesWithin,
} from '../../services/reviewStopHandle';

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
  /**
   * The run's own private-context marker, fixed when the run starts: the value
   * its ConversationRun records. Absent, the run's context is unknown.
   */
  privateContext?: AnalysisPrivateContextMarker;
  query: string;
  history: ConversationMessage[];
  getHistoryTurns?(): readonly AnalysisHistoryTurn[];
  traceContext: ConversationTraceContext;
  selectionContext?: AnalysisOptions['selectionContext'];
  /** This turn's requested source depth: its own, else the conversation's last one. */
  sourceDepth?: AnalysisOptions['sourceDepth'];
  onUpdate?(update: unknown): void;
  /**
   * Display-only answer draft (`answer_token` / `answer_segment_reset`) from a
   * draft-capable runtime. Delivered live only: never retained for replay or
   * written to history, and superseded by provisional_answer / run_completed.
   */
  onAnswerDraft?(update: unknown): void;
  /**
   * The finished answer, owner-projected, while its semantic review runs. At
   * most once per run; `run_completed` carries the same answer with its verdict.
   */
  onProvisionalAnswer?(answer: {message: string}): boolean | void;
  /**
   * Ends only the semantic review of a delivered answer: the review resolves
   * `cancelled_by_user` and the run still finalizes and commits its turn.
   * Owned by the session service's stop state; cancel() remains the full abort.
   */
  reviewStopSignal?: AbortSignal;
}

export interface ConversationRuntimeAdapter {
  run(input: ConversationRuntimeInput): Promise<ConversationRuntimeOutcome>;
  cancel(sessionId: string, runId: string): Promise<void>;
  dispose?(): void | Promise<void>;
}

type ConversationSessionEventPayload =
  | {type: 'run_started'; sessionId: string; runId: string}
  | {type: 'runtime_update'; sessionId: string; runId: string; update: unknown}
  | {type: 'provisional_answer'; sessionId: string; runId: string; message: string; verification: 'pending'}
  | {
      type: 'run_completed';
      sessionId: string;
      runId: string;
      outcome: ConversationRuntimeOutcome;
    }
  | {type: 'run_failed'; sessionId: string; runId: string; error: string};

/** A replayable run event, ordered by `seqId`, which is also its SSE id. */
export type ConversationSessionEvent = ConversationSessionEventPayload & {seqId: number};
/**
 * A live-only event (an answer draft): no `seqId`, so it has no SSE id a
 * reconnect cursor (Last-Event-ID) could land on, and it is never replayed.
 */
export type ConversationLiveEvent = ConversationSessionEventPayload & {liveOnly: true};
export type ConversationPublishedEvent = ConversationSessionEvent | ConversationLiveEvent;

export interface ConversationRun {
  runId: string;
  query: string;
  turnIndex: number;
  analysisContextFingerprint?: string;
  status: 'running' | 'completed' | 'cancelled' | 'failed';
  startedAt: number;
  completedAt?: number;
  outcome?: ConversationRuntimeOutcome;
  error?: string;
  completion: Promise<ConversationRuntimeOutcome>;
  events: ConversationSessionEvent[];
  lifecycleSettled?: boolean;
  /**
   * Fixed at admission from the selection this run was authorized with. A
   * session's selection is pinned by its authorization fingerprint, so a
   * restored run's marker is its session's.
   */
  privateContext: AnalysisPrivateContextMarker;
}

export interface ConversationSession extends ManagedAssistantSession {
  runtime: ConversationRuntimeAdapter;
  history: ConversationMessage[];
  historyTurns: AnalysisHistoryTurn[];
  recoveryStatus?: 'available' | 'unavailable' | 'interrupted';
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
  analysisContextFingerprint: string;
  outputLanguage?: AnalysisOptions['outputLanguage'];
  codeAwareMode?: AnalysisOptions['codeAwareMode'];
  codebaseIds?: string[];
  knowledgeSourceIds?: string[];
  sourceDepth?: AnalysisOptions['sourceDepth'];
  sourceAuthorization?: {
    codeAwareMode: NonNullable<AnalysisOptions['codeAwareMode']>;
    codebaseIds: string[];
  };
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
  /** The request's current authorization fingerprint; a session's turns all run under one. */
  analysisContextFingerprint: string;
}

/**
 * A stop of a delivered answer returns at once (`review_stop_requested`); the
 * turn then arrives with `run_completed`. Every other stop settles first.
 */
export type ConversationCancelResult =
  | {status: 'review_stop_requested'}
  | {status: 'settled'; outcome: ConversationRuntimeOutcome};

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
  /** Bound on the commit after a review-only or force stop; see resolveReviewStopWatchdogMs. */
  reviewStopWatchdogMs?: number;
  onRunStarted?(session: ConversationSession, run: ConversationRun): void;
  onRunSettled?(session: ConversationSession, run: ConversationRun): void;
  /**
   * The owner-facing text of a failed run, used for its stored error and its
   * `run_failed` event alike, e.g. projected for a private-knowledge run;
   * undefined keeps the error's message.
   */
  projectRunError?(session: ConversationSession, run: ConversationRun, error: unknown): string | undefined;
}

function defaultCreateId(prefix: 'conversation' | 'run'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** A conversation request the caller has to change: its text and code are the route contract. */
export class ConversationRequestError extends PublicRequestError {}

function conversationNotFound(sessionId?: string): ConversationRequestError {
  return new ConversationRequestError('CONVERSATION_NOT_FOUND',
    sessionId ? `Conversation session not found: ${sessionId}` : 'Conversation session not found', 404);
}

const MAX_REPLAY_EVENTS_PER_RUN = 512;

function normalizeTraceContext(
  context: ConversationTraceContext | undefined,
): ConversationTraceContext {
  if (context?.kind !== 'attached') return {kind: 'none'};
  const traceId = context.traceId.trim();
  if (!traceId) throw new ConversationRequestError('INVALID_TRACE_CONTEXT', 'Attached conversation traceId must not be empty');
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
  private readonly reviewStopWatchdogMs: number;
  private readonly onRunStarted?: ConversationSessionServiceDeps['onRunStarted'];
  private readonly onRunSettled?: ConversationSessionServiceDeps['onRunSettled'];
  private readonly projectRunError?: ConversationSessionServiceDeps['projectRunError'];
  private readonly listeners = new Map<string, Set<(event: ConversationPublishedEvent) => void>>();
  private nextEventSeqId = 0;
  private readonly cancellationRequested = new WeakSet<ConversationRun>();
  private readonly runAuthorizationChecks = new WeakMap<ConversationRun, () => void>();
  /** Stop state and delivery of each run; never serialized. */
  private readonly runStops = new WeakMap<ConversationRun, ReviewStopController<ConversationRuntimeOutcome>>();

  constructor(deps: ConversationSessionServiceDeps) {
    this.createRuntime = deps.createRuntime;
    this.createId = deps.createId ?? defaultCreateId;
    this.now = deps.now ?? Date.now;
    this.cancelSettleTimeoutMs = deps.cancelSettleTimeoutMs ?? 120_000;
    this.reviewStopWatchdogMs = deps.reviewStopWatchdogMs ?? resolveReviewStopWatchdogMs();
    this.onRunStarted = deps.onRunStarted;
    this.onRunSettled = deps.onRunSettled;
    this.projectRunError = deps.projectRunError;
  }

  getSession(sessionId: string): ConversationSession | undefined {
    return this.sessions.getSession(sessionId);
  }

  /** Caller checks current provider, Trace access and source grants before loading history. */
  restoreSession(descriptor: ConversationSessionDescriptor, turns: readonly AnalysisHistoryTurn[],
    input: StartConversationTurnInput): ConversationSession {
    const existing = this.sessions.getSession(descriptor.sessionId);
    if (existing) return existing;
    if (!input.owner || input.owner.userId !== descriptor.userId || input.owner.tenantId !== descriptor.tenantId ||
      input.owner.workspaceId !== descriptor.workspaceId || input.providerId !== descriptor.providerId ||
      input.providerSnapshotHash !== descriptor.providerSnapshotHash || input.runtimeKind !== descriptor.runtimeKind ||
      input.analysisContextFingerprint !== descriptor.analysisContextFingerprint ||
      !traceContextsEqual(normalizeTraceContext(input.traceContext), descriptor.traceContext)) {
      throw new ConversationRequestError('CONVERSATION_RECOVERY_UNAVAILABLE',
        'The conversation no longer matches its owner, provider or attached Trace', 409);
    }
    assertCurrentAnalysisContextAuthorization(descriptor, resolveKnowledgeScope(descriptor),
      descriptor.analysisContextFingerprint);
    const historyTurns = structuredClone([...turns]);
    const interrupted = descriptor.lastRun.status === 'running';
    if (interrupted) {
      const prior = historyTurns.findIndex(turn => turn.id === descriptor.lastRun.runId);
      const originalFingerprint = prior >= 0 ? historyTurns[prior].analysisContextFingerprint : undefined;
      if (prior >= 0) historyTurns.splice(prior, 1);
      historyTurns.push(toAnalysisHistoryTurn({id: descriptor.lastRun.runId,
        turnIndex: descriptor.lastRun.turnIndex, query: descriptor.lastRun.query,
        traceId: descriptor.traceContext.kind === 'attached' ? descriptor.traceContext.traceId :
          `conversation-no-trace:${descriptor.sessionId}`,
        timestamp: descriptor.lastRun.startedAt, sourceDerived: descriptor.lastRun.sourceDerived,
        analysisContextFingerprint: originalFingerprint,
        result: {partial: true, completion: {status: 'incomplete'}, terminationReason: 'execution_error',
          terminationMessage: 'conversation_run_interrupted_before_final_commit'},
      }));
    }
    const history = historyTurns.flatMap((turn): ConversationMessage[] => [
      {role: 'user', content: turn.query, turnId: turn.id, ...(!turn.answer ? {turn} : {}),
        ...(turn.sourceDerived ? {sourceDerived: true} : {})},
      ...(turn.answer ? [{role: 'assistant' as const, content: turn.answer, turnId: turn.id, turn,
        ...(turn.sourceDerived ? {sourceDerived: true} : {})}] : []),
    ]);
    const outcome = interrupted ? undefined : descriptor.lastOutcome as ConversationRuntimeOutcome | undefined;
    const session: ConversationSession = {...descriptor, runtime: this.createRuntime(input), history, historyTurns,
      status: interrupted ? 'failed' : descriptor.status, sseClients: [], runs: [],
      recoveryStatus: interrupted ? 'interrupted' : 'available',
      ...(interrupted ? {error: 'conversation_run_interrupted_before_final_commit'} : {}),
      ...(outcome?.kind === 'needs_user_input' ? {pendingQuestion: outcome.question} : {}),
      ...(outcome?.kind === 'recommend_full' ? {recommendedFullAnalysis: true, fullAnalysisHandoff: outcome.handoff} : {}),
      evidence: outcome?.evidence ?? [],
    };
    // Settled history is replayable; an interrupted SDK has no live execution or pending promise.
    if (outcome) session.runs.push({runId: descriptor.lastRun.runId, query: descriptor.lastRun.query,
      turnIndex: descriptor.lastRun.turnIndex, status: descriptor.lastRun.status === 'cancelled' ? 'cancelled' : 'completed',
      startedAt: descriptor.lastRun.startedAt, completedAt: descriptor.lastRun.completedAt, outcome,
      completion: Promise.resolve(outcome), lifecycleSettled: true, events: [],
      privateContext: resolveAnalysisPrivateContext(session)});
    this.sessions.setSession(session.sessionId, session);
    return session;
  }

  subscribe(
    sessionId: string,
    listener: (event: ConversationPublishedEvent) => void,
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
    if (!query) throw new ConversationRequestError('CONVERSATION_QUERY_REQUIRED', 'Conversation query is required');

    let session = input.sessionId
      ? this.sessions.getSession(input.sessionId)
      : undefined;
    const isNewSession = !session;
    if (input.sessionId && !session) {
      throw conversationNotFound(input.sessionId);
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
        historyTurns: [],
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
        analysisContextFingerprint: input.analysisContextFingerprint,
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
        ...(input.runtimeOptions?.sourceDepth ? {sourceDepth: input.runtimeOptions.sourceDepth} : {}),
        ...(input.runtimeOptions?.codeAwareMode &&
          input.runtimeOptions.codeAwareMode !== 'off' &&
          input.runtimeOptions.codebaseIds?.length
          ? {
              sourceAuthorization: {
                codeAwareMode: input.runtimeOptions.codeAwareMode,
                codebaseIds: [...input.runtimeOptions.codebaseIds],
              },
            }
          : {}),
      };
      this.sessions.setSession(sessionId, session);
    }
    if (input.owner && (session.userId !== input.owner.userId || session.tenantId !== input.owner.tenantId ||
      session.workspaceId !== input.owner.workspaceId)) throw conversationNotFound();
    if (!isNewSession && input.analysisContextFingerprint !== session.analysisContextFingerprint) {
      throw new ConversationRequestError('ANALYSIS_CONTEXT_CHANGED_RESTART_REQUIRED',
        'Start a new conversation after changing authorized sources', 409);
    }
    const requestedTraceContext = input.traceContext
      ? normalizeTraceContext(input.traceContext)
      : session.traceContext;
    if (!isNewSession && !traceContextsEqual(session.traceContext, requestedTraceContext)) {
      throw new ConversationRequestError('CONVERSATION_TRACE_CHANGED',
        'Start a new conversation after changing the attached Trace', 409);
    }
    if (
      !isNewSession &&
      input.providerId !== undefined &&
      session.providerId !== input.providerId
    ) {
      throw new ConversationRequestError('CONVERSATION_PROVIDER_CHANGED',
        'Start a new conversation after changing the AI provider', 409);
    }
    if (
      !isNewSession &&
      input.providerSnapshotHash &&
      session.providerSnapshotHash &&
      session.providerSnapshotHash !== input.providerSnapshotHash
    ) {
      throw new ConversationRequestError('CONVERSATION_PROVIDER_SNAPSHOT_CHANGED',
        'Start a new conversation after changing the AI provider configuration', 409);
    }
    if (session.activeRun) {
      throw new ConversationRequestError('RUN_ALREADY_ACTIVE',
        `Conversation already in progress for session ${session.sessionId}`, 409);
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
    const stop = this.createRunStop(session, () => run);
    const privateContext = resolveAnalysisPrivateContext(session);
    const sourceDepth = input.runtimeOptions?.sourceDepth ?? session.sourceDepth;
    const runtimeInput: ConversationRuntimeInput = {
      sessionId: session.sessionId,
      runId,
      privateContext,
      query,
      history: session.history.map((message) => ({...message})),
      getHistoryTurns: () => {
        this.runAuthorizationChecks.get(run)?.();
        return session!.historyTurns.filter(turn => turn.id !== runId);
      },
      traceContext: session.traceContext,
      selectionContext: input.runtimeOptions?.selectionContext,
      ...(sourceDepth ? {sourceDepth} : {}),
      onUpdate: (update) => {
        if (!this.isCurrentRun(session!, run) || this.cancellationRequested.has(run)) return;
        this.runAuthorizationChecks.get(run)?.();
        if (!this.isCurrentRun(session!, run) || this.cancellationRequested.has(run)) return;
        this.publish(session!.sessionId, {type: 'runtime_update', sessionId: session!.sessionId, runId, update});
      },
      onAnswerDraft: (update) => {
        if (!this.isCurrentRun(session!, run) || this.cancellationRequested.has(run) || stop.provisionalDelivered) return;
        // A draft is display-only: a revoked authorization drops it; the run's
        // own path reports the revocation.
        try {
          this.runAuthorizationChecks.get(run)?.();
        } catch {
          return;
        }
        if (!this.isCurrentRun(session!, run) || this.cancellationRequested.has(run)) return;
        this.publish(session!.sessionId, {type: 'runtime_update', sessionId: session!.sessionId, runId, update},
          {liveOnly: true});
      },
      onProvisionalAnswer: ({message: answer}) => {
        if (!answer.trim() || stop.provisionalDelivered) return false;
        if (!this.isCurrentRun(session!, run) || this.cancellationRequested.has(run)) return false;
        this.runAuthorizationChecks.get(run)?.();
        if (!this.isCurrentRun(session!, run) || this.cancellationRequested.has(run)) return false;
        stop.markDelivered(answer);
        this.publish(session!.sessionId, {type: 'provisional_answer', sessionId: session!.sessionId, runId,
          message: answer, verification: 'pending'});
        return true;
      },
      reviewStopSignal: stop.signal,
    };
    const run: ConversationRun = {
      runId,
      query,
      turnIndex: Math.max(-1, ...session.historyTurns.map(turn => turn.turnIndex),
        ...session.runs.map(previous => previous.turnIndex)) + 1,
      status: 'running',
      startedAt: this.now(),
      completion: Promise.resolve({kind: 'cancelled', message: ''}),
      events: [],
      privateContext,
    };
    const authorizationSelection = runAnalysisSelection(session);
    const authorizationScope = resolveKnowledgeScope(session);
    // Bind only new turns to the grant checked for this run; older entries keep their original provenance.
    const authorizationFingerprint = session.analysisContextFingerprint;
    run.analysisContextFingerprint = authorizationFingerprint;
    this.runStops.set(run, stop);
    this.runAuthorizationChecks.set(run, () => assertCurrentAnalysisContextAuthorization(
      authorizationSelection, authorizationScope, authorizationFingerprint));
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
    // A started turn that names a depth keeps it for the turns after it.
    if (input.runtimeOptions?.sourceDepth) session.sourceDepth = input.runtimeOptions.sourceDepth;
    if (this.isCurrentRun(session, run) && !this.cancellationRequested.has(run)) {
      this.publish(session.sessionId, {type: 'run_started', sessionId: session.sessionId, runId});
    }
    if (this.isCurrentRun(session, run) && !this.cancellationRequested.has(run)) {
      session.history.push({role: 'user', content: query, turnId: runId,
        ...(privateContextRestrictsAudience(run.privateContext) ? {sourceDerived: true} : {})});
    }

    let runtimeCompletion: Promise<ConversationRuntimeOutcome>;
    try {
      if (this.isCurrentRun(session, run) && !this.cancellationRequested.has(run)) this.runAuthorizationChecks.get(run)?.();
      runtimeCompletion = this.isCurrentRun(session, run) && !this.cancellationRequested.has(run)
        ? session.runtime.run(runtimeInput) : Promise.resolve({kind: 'cancelled', message: ''});
    } catch (error) {
      runtimeCompletion = Promise.reject(error);
    }
    const completion = runtimeCompletion
      .then((outcome) => {
        return this.commitRun(session!, run, outcome, true) ?? {kind: 'cancelled' as const, message: ''};
      })
      .catch((error: unknown) => {
        if (!this.isCurrentRun(session!, run)) return {kind: 'cancelled' as const, message: ''};
        if (this.cancellationRequested.has(run)) return this.settleCancelledRun(session!, run);
        const message = this.projectRunError?.(session!, run, error) ??
          (error instanceof Error ? error.message : String(error));
        run.status = 'failed';
        run.error = message;
        run.completedAt = this.now();
        session!.status = 'failed';
        session!.error = message;
        session!.lastActivityAt = run.completedAt;
        this.recordRunHistory(session!, run);
        session!.activeRun = undefined;
        this.settleRun(session!, run);
        if (this.isLatestRun(session!, run)) this.publish(session!.sessionId, {
          type: 'run_failed', sessionId: session!.sessionId, runId, error: message,
        });
        throw error;
      });
    run.completion = completion;
    void completion.then(() => stop.dispose(), () => stop.dispose());

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
    if (!session) throw conversationNotFound(input.sessionId);
    if (session.activeRun) {
      await this.supersedeRun(session.sessionId, session.activeRun.runId);
    }
    // A steer continues the session under the authorization it already holds.
    return this.startTurn({...input, analysisContextFingerprint: session.analysisContextFingerprint});
  }

  /**
   * Stop request for the active run. Before an answer is delivered it is a full
   * cancel. After delivery the first stop ends only the review and returns at
   * once; the run commits its normal turn (the watchdog bounds that commit). A
   * second stop forces: it waits for that commit up to the same watchdog, then
   * aborts, persisting the read body as an unverified partial turn if needed.
   */
  async cancelRun(sessionId: string, runId: string): Promise<ConversationCancelResult> {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw conversationNotFound(sessionId);
    const run = session.activeRun;
    if (!run || run.runId !== runId) {
      throw new ConversationRequestError('CONVERSATION_RUN_NOT_ACTIVE', `Active conversation run not found: ${runId}`, 409);
    }
    const stop = this.runStops.get(run);
    const request = stop?.requestStop() ?? 'full';
    if (stop?.provisionalDelivered) {
      if (request === 'review') return {status: 'review_stop_requested'};
      await stop.awaitCommitOrExpire(run.completion);
      return {status: 'settled', outcome: run.outcome ?? {kind: 'cancelled', message: ''}};
    }
    return {status: 'settled', outcome: await this.cancelUndeliveredRun(session, run)};
  }

  /**
   * A new turn or steer replaces the active run: stop it and wait for its
   * terminal commit within one watchdog bound, never a review plus a cancel.
   */
  async supersedeRun(sessionId: string, runId: string): Promise<ConversationRuntimeOutcome> {
    const first = await this.cancelRun(sessionId, runId);
    if (first.status === 'settled') return first.outcome;
    const session = this.sessions.getSession(sessionId);
    const run = session?.runs.find(candidate => candidate.runId === runId);
    if (!session || !run || session.activeRun !== run) return run?.outcome ?? {kind: 'cancelled', message: ''};
    const forced = await this.cancelRun(sessionId, runId);
    return forced.status === 'settled' ? forced.outcome : run.outcome ?? {kind: 'cancelled', message: ''};
  }

  private async cancelUndeliveredRun(session: ConversationSession, run: ConversationRun): Promise<ConversationRuntimeOutcome> {
    this.cancellationRequested.add(run);
    const cancellation = Promise.resolve().then(() => session.runtime.cancel(session.sessionId, run.runId))
      .then(() => run.completion);
    try {
      if (!await settlesWithin(cancellation, this.cancelSettleTimeoutMs)) {
        throw new ConversationRequestError('CANCELLATION_IN_PROGRESS',
          `Conversation cancellation did not settle within ${this.cancelSettleTimeoutMs}ms`, 409);
      }
      return await cancellation;
    } finally {
      if (this.isCurrentRun(session, run)) this.settleCancelledRun(session, run);
    }
  }

  /**
   * The run's stop controller. Its watchdog fallback keeps the owner-projected
   * message the user read (the conversation never holds the raw body), and the
   * privacy rule is per run: registered source counts only when this run used it.
   */
  private createRunStop(session: ConversationSession,
    getRun: () => ConversationRun): ReviewStopController<ConversationRuntimeOutcome> {
    const abortRuntime = (run: ConversationRun) => {
      this.cancellationRequested.add(run);
      void Promise.resolve().then(() => session.runtime.cancel(session.sessionId, run.runId)).catch(() => undefined);
    };
    return new ReviewStopController<ConversationRuntimeOutcome>({watchdogMs: this.reviewStopWatchdogMs, owner: {
      mayPersistPartial: () => mayPersistUnverifiedBody({
        // A private run's unverified body stays live-only: no watchdog fallback persists it.
        privateKnowledge: privateContextRestrictsAudience(getRun().privateContext),
        isCurrent: () => this.isCurrentRun(session, getRun()),
        assertAuthorized: () => this.runAuthorizationChecks.get(getRun())?.(),
      }),
      commitPartial: message => {
        const run = getRun();
        const accepted = this.commitRun(session, run, {kind: 'answered', message,
          finalResult: buildReviewNotFinishedResult({sessionId: session.sessionId, conclusion: message,
            outputLanguage: session.outputLanguage ?? 'zh-CN'})});
        if (!accepted) return false;
        // The finalization that never settled is abandoned; its late result is ignored.
        abortRuntime(run);
        return true;
      },
      fullCancel: () => {
        const run = getRun();
        if (!this.isCurrentRun(session, run)) return run.outcome ?? {kind: 'cancelled', message: ''};
        abortRuntime(run);
        return this.settleCancelledRun(session, run);
      },
    }});
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
          this.cancellationRequested.add(activeRun);
          activeRun.status = 'cancelled';
          activeRun.completedAt = options.now ?? this.now();
          session.status = 'cancelled';
          session.activeRun = undefined;
          this.recordRunHistory(session, activeRun, {kind: 'cancelled', message: ''});
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

  private isCurrentRun(session: ConversationSession, run: ConversationRun): boolean {
    return this.sessions.getSession(session.sessionId) === session && session.activeRun === run &&
      run.status === 'running' && !run.lifecycleSettled;
  }

  private isLatestRun(session: ConversationSession, run: ConversationRun): boolean {
    return this.sessions.getSession(session.sessionId) === session && session.runs[session.runs.length - 1] === run;
  }

  private settleCancelledRun(session: ConversationSession, run: ConversationRun): ConversationRuntimeOutcome {
    const outcome: ConversationRuntimeOutcome = {kind: 'cancelled', message: ''};
    return this.commitRun(session, run, outcome) ?? outcome;
  }

  /**
   * The single terminal write of a run: outcome and history in memory, then the
   * durable commit (onRunSettled, one SQLite transaction that refuses a turn
   * already terminal), in one synchronous step. The first writer wins; a run
   * that is no longer current writes nothing. Once settled, the latest run
   * announces its outcome; a settlement hook that started a newer run silences it.
   */
  private commitRun(
    session: ConversationSession,
    run: ConversationRun,
    outcome: ConversationRuntimeOutcome,
    finalized = false,
  ): ConversationRuntimeOutcome | undefined {
    const accepted = this.completeRun(session, run, outcome, finalized);
    if (!accepted) return undefined;
    this.settleRun(session, run);
    if (this.isLatestRun(session, run)) {
      this.publish(session.sessionId, {type: 'run_completed', sessionId: session.sessionId, runId: run.runId,
        outcome: accepted});
    }
    return accepted;
  }

  private completeRun(
    session: ConversationSession,
    run: ConversationRun,
    outcome: ConversationRuntimeOutcome,
    finalized: boolean,
  ): ConversationRuntimeOutcome | undefined {
    if (!this.isCurrentRun(session, run)) return undefined;
    // After delivery the user already holds the answer: a finalized outcome that
    // reaches the commit wins over a stop. A run that is no longer current (a
    // replaced session or run) never reaches this point.
    if (this.cancellationRequested.has(run) && outcome.kind !== 'cancelled' &&
      !(finalized && this.runStops.get(run)?.provisionalDelivered)) outcome = {kind: 'cancelled', message: ''};
    try {this.runAuthorizationChecks.get(run)?.();}
    catch (error) {
      if (outcome.kind !== 'cancelled') throw error;
      // Local cancellation can settle after revocation, but cannot retain private runtime facts.
      outcome = {kind: 'cancelled', message: ''};
    }
    if (!this.isCurrentRun(session, run)) return undefined;
    const completedAt = this.now();
    run.outcome = outcome;
    run.completedAt = completedAt;
    run.status = outcome.kind === 'cancelled' ? 'cancelled' : 'completed';
    this.recordRunHistory(session, run, outcome);
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
    if (session.activeRun === run) session.activeRun = undefined;
    return outcome;
  }

  private recordRunHistory(session: ConversationSession, run: ConversationRun, outcome?: ConversationRuntimeOutcome): void {
    if (session.historyTurns.some(turn => turn.id === run.runId)) return;
    const historyTurn = toAnalysisHistoryTurn({id: run.runId, turnIndex: run.turnIndex, query: run.query,
      timestamp: run.completedAt ?? run.startedAt, analysisContextFingerprint: run.analysisContextFingerprint,
      traceId: session.traceContext.kind === 'attached' ? session.traceContext.traceId :
        `conversation-no-trace:${session.sessionId}`,
      sourceDerived: privateContextRestrictsAudience(run.privateContext),
      result: outcome?.finalResult ?? (outcome ? {message: outcome.message,
        partial: outcome.kind === 'cancelled', completion: {status: outcome.kind === 'cancelled' ? 'incomplete' : 'completed'}} :
        {partial: true, completion: {status: 'incomplete'}, terminationReason: 'execution_error'}),
    });
    session.historyTurns.push(historyTurn);
    const userMessage = session.history.find(message => message.role === 'user' && message.turnId === run.runId);
    if (userMessage && !outcome?.message.trim()) userMessage.turn = historyTurn;
    if (outcome?.message.trim()) session.history.push({role: 'assistant', content: outcome.message,
      turnId: run.runId, turn: historyTurn, ...(historyTurn.sourceDerived ? {sourceDerived: true} : {})});
  }

  private settleRun(session: ConversationSession, run: ConversationRun): void {
    if (run.lifecycleSettled) return;
    run.lifecycleSettled = true;
    try {
      this.onRunSettled?.(session, run);
      if (this.isLatestRun(session, run)) session.recoveryStatus = 'available';
    } catch {
      // Preserve the answer, but never promise recovery when the final commit failed.
      if (this.isLatestRun(session, run)) session.recoveryStatus = 'unavailable';
      if (run.outcome) run.outcome.recoveryStatus = 'unavailable';
    }
  }

  /** `liveOnly` events reach current subscribers only; a reconnect never replays them. */
  private publish(sessionId: string, payload: ConversationSessionEventPayload,
    delivery: {liveOnly?: boolean} = {}): void {
    if (delivery.liveOnly) {
      const live: ConversationLiveEvent = {...payload, liveOnly: true};
      for (const listener of this.listeners.get(sessionId) ?? []) listener(live);
      return;
    }
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
