// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {StreamingUpdate} from '../agent/types';
import {readAnswerDraftIdentity} from '../agentRuntime/answerDraftStream';
import {runtimeSupportsDraftAnswerStreaming} from '../agentRuntime/runtimeDescriptors';
import type {OutputLanguage} from '../agentv3/outputLanguage';
import {AnalysisNarrativeStreamProjection} from './analysisNarrativeStreamProjection';
import {projectOwnerCodeAwareStreamingUpdate} from './security/codeAwareStreamingUpdateProjection';

/** Coalescing window for one draft delivery. */
export const ANSWER_DRAFT_FLUSH_INTERVAL_MS = 200;
/** Visible characters that are delivered without waiting for the window. */
export const ANSWER_DRAFT_FLUSH_CHARS = 256;

export interface AnswerDraftRelayOptions {
  runId: string;
  /**
   * The owner projection of the surface. Returning null (including for a token
   * whose text the private guard suppressed) or throwing withdraws the draft
   * for the rest of the run: a draft is never worth an unsafe byte.
   */
  project(update: StreamingUpdate): StreamingUpdate | null;
  /**
   * Live-only delivery: callers never persist or replay what this emits. A
   * throwing delivery (for example a revoked authorization) withdraws the
   * draft like a projection failure; it never escapes the relay.
   */
  deliver(update: StreamingUpdate): void;
}

function visibleText(update: StreamingUpdate | undefined): string {
  if (!update) return '';
  if (typeof update.content === 'string') return update.content;
  const content = update.content as Record<string, unknown> | undefined;
  const token = content?.token ?? content?.delta;
  return typeof token === 'string' ? token : '';
}

/**
 * Per-run relay from a draft-capable runtime to one product surface: owner
 * projection, then sidecar-free narrative projection, then coalescing. A reset
 * drops whatever is still buffered (it is never flushed) and is forwarded, and
 * events of an earlier segment or another run are dropped.
 */
export class AnswerDraftRelay {
  private readonly narrative = new AnalysisNarrativeStreamProjection();
  private attempt = 0;
  private buffer = '';
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastDeliveryAt = 0;
  private shown = false;
  private closed = false;

  constructor(private readonly options: AnswerDraftRelayOptions) {}

  accept(update: StreamingUpdate): void {
    if (this.closed || (update.type !== 'answer_token' && update.type !== 'answer_segment_reset')) return;
    const identity = readAnswerDraftIdentity(update);
    if (!identity || identity.runId !== this.options.runId || identity.attempt < this.attempt) return;
    if (update.type === 'answer_segment_reset' || identity.attempt > this.attempt) {
      this.attempt = identity.attempt;
      this.revoke(update.timestamp);
      if (update.type === 'answer_segment_reset') return;
    }
    let projected: StreamingUpdate | null;
    try {
      projected = this.options.project(update);
    } catch {
      projected = null;
    }
    if (!projected) {
      this.withdraw(update.timestamp);
      return;
    }
    this.append(visibleText(this.narrative.project(projected)));
  }

  /** The runtime settled: deliver the withheld tail and accept nothing more. */
  settle(): void {
    if (this.closed) return;
    this.append(visibleText(this.narrative.finish()));
    this.flush();
    this.close();
  }

  /** Cancellation or failure: drop everything still buffered. */
  dispose(): void {
    this.close();
  }

  private append(text: string): void {
    if (!text) return;
    this.buffer += text;
    if (this.buffer.length >= ANSWER_DRAFT_FLUSH_CHARS) {
      this.flush();
      return;
    }
    if (this.timer) return;
    const wait = Math.max(0, this.lastDeliveryAt + ANSWER_DRAFT_FLUSH_INTERVAL_MS - Date.now());
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, wait);
    this.timer.unref?.();
  }

  private flush(): void {
    this.cancelTimer();
    if (this.closed || !this.buffer) return;
    const token = this.buffer;
    this.buffer = '';
    this.shown = true;
    this.lastDeliveryAt = Date.now();
    this.send({type: 'answer_token',
      content: {token, runId: this.options.runId, attempt: this.attempt}, timestamp: this.lastDeliveryAt});
  }

  private revoke(timestamp: number): void {
    this.cancelTimer();
    this.buffer = '';
    this.narrative.reset();
    this.shown = false;
    this.send({type: 'answer_segment_reset',
      content: {runId: this.options.runId, attempt: this.attempt}, timestamp});
  }

  private withdraw(timestamp: number): void {
    const shown = this.shown;
    this.close();
    // Clear what the client already shows; its next segment never comes.
    if (shown) {
      this.send({type: 'answer_segment_reset',
        content: {runId: this.options.runId, attempt: this.attempt + 1}, timestamp});
    }
  }

  /**
   * Runs on timer callbacks too, where an escaping throw would be an uncaught
   * exception. A failed delivery closes the relay: the surface can no longer
   * be told anything, so nothing more is sent.
   */
  private send(update: StreamingUpdate): void {
    try {
      this.options.deliver(update);
    } catch {
      this.close();
    }
  }

  private close(): void {
    this.closed = true;
    this.cancelTimer();
    this.buffer = '';
    this.narrative.reset();
  }

  private cancelTimer(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}

/**
 * The relay for one run of one surface, or undefined when the pinned runtime
 * does not implement the draft reset contract. For a private run the owner
 * projection here is a second check, after the runtime's own; its failure also
 * withdraws. `privateKnowledge` must be the same flag the surface passes to its
 * owner streaming projection; without it that projection returns every update as is.
 */
export function createAnswerDraftRelay(input: {
  runtimeKind: string | undefined;
  runId: string;
  /** The session id the surface's output guards are registered under. */
  projectionSessionId: string;
  privateKnowledge: boolean;
  outputLanguage: OutputLanguage;
  deliver(update: StreamingUpdate): void;
}): AnswerDraftRelay | undefined {
  if (!runtimeSupportsDraftAnswerStreaming(input.runtimeKind)) return undefined;
  return new AnswerDraftRelay({runId: input.runId, deliver: input.deliver,
    project: update => projectOwnerCodeAwareStreamingUpdate(input.projectionSessionId, update,
      input.privateKnowledge, input.outputLanguage)});
}
