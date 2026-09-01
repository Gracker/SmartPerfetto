// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {ConversationEvidenceRef} from '../contracts/conversationContract';

export interface ConversationSourceEnrichmentMetrics {
  searchCalls: number;
  readCalls: number;
  durationMs: number;
}

export interface ConversationSourceEnrichmentOutcome {
  message: string;
  evidence: ConversationEvidenceRef[];
  metrics: ConversationSourceEnrichmentMetrics;
}

export type ConversationSourceEnrichmentStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface ConversationSourceEnrichmentState {
  sessionId: string;
  runId: string;
  status: ConversationSourceEnrichmentStatus;
  startedAt: number;
  completedAt?: number;
  message?: string;
  evidence?: ConversationEvidenceRef[];
  metrics?: ConversationSourceEnrichmentMetrics;
  errorCode?: 'source_enrichment_failed';
  completion: Promise<void>;
}

export type ConversationSourceEnrichmentEvent =
  | {type: 'source_enrichment_started'; sessionId: string; runId: string}
  | ({type: 'source_enrichment_completed'} & ConversationSourceEnrichmentOutcome & {
      sessionId: string;
      runId: string;
    })
  | {
      type: 'source_enrichment_failed';
      sessionId: string;
      runId: string;
      errorCode: 'source_enrichment_failed';
    }
  | {type: 'source_enrichment_cancelled'; sessionId: string; runId: string};

export interface ConversationSourceEnrichmentCoordinatorOptions {
  now?: () => number;
  onEvent(event: ConversationSourceEnrichmentEvent): void;
}

export interface StartConversationSourceEnrichmentInput {
  sessionId: string;
  runId: string;
  execute(): Promise<ConversationSourceEnrichmentOutcome>;
  cancel(): Promise<void>;
}

interface ActiveSourceEnrichment {
  state: ConversationSourceEnrichmentState;
  cancel: () => Promise<void>;
}

export class ConversationSourceEnrichmentCoordinator {
  private readonly now: () => number;
  private readonly onEvent: (event: ConversationSourceEnrichmentEvent) => void;
  private readonly active = new Map<string, ActiveSourceEnrichment>();

  constructor(options: ConversationSourceEnrichmentCoordinatorOptions) {
    this.now = options.now ?? Date.now;
    this.onEvent = options.onEvent;
  }

  get(runId: string): ConversationSourceEnrichmentState | undefined {
    return this.active.get(runId)?.state;
  }

  remove(runId: string): void {
    this.active.delete(runId);
  }

  start(input: StartConversationSourceEnrichmentInput): ConversationSourceEnrichmentState {
    if (this.active.has(input.runId)) {
      throw new Error(`Source enrichment already exists for run ${input.runId}`);
    }
    const state: ConversationSourceEnrichmentState = {
      sessionId: input.sessionId,
      runId: input.runId,
      status: 'running',
      startedAt: this.now(),
      completion: Promise.resolve(),
    };
    this.active.set(input.runId, {state, cancel: input.cancel});
    this.onEvent({
      type: 'source_enrichment_started',
      sessionId: input.sessionId,
      runId: input.runId,
    });

    state.completion = Promise.resolve()
      .then(input.execute)
      .then((outcome) => {
        if (state.status !== 'running') return;
        state.status = 'completed';
        state.completedAt = this.now();
        state.message = outcome.message;
        state.evidence = outcome.evidence.map(item => ({...item}));
        state.metrics = {...outcome.metrics};
        this.onEvent({
          type: 'source_enrichment_completed',
          sessionId: input.sessionId,
          runId: input.runId,
          message: state.message,
          evidence: state.evidence,
          metrics: state.metrics,
        });
      })
      .catch(() => {
        if (state.status !== 'running') return;
        state.status = 'failed';
        state.completedAt = this.now();
        state.errorCode = 'source_enrichment_failed';
        this.onEvent({
          type: 'source_enrichment_failed',
          sessionId: input.sessionId,
          runId: input.runId,
          errorCode: state.errorCode,
        });
      });
    return state;
  }

  async cancel(runId: string): Promise<boolean> {
    const active = this.active.get(runId);
    if (!active || active.state.status !== 'running') return false;
    active.state.status = 'cancelled';
    active.state.completedAt = this.now();
    this.onEvent({
      type: 'source_enrichment_cancelled',
      sessionId: active.state.sessionId,
      runId,
    });
    await active.cancel().catch(() => undefined);
    return true;
  }
}
