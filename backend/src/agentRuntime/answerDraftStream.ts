// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {StreamingUpdate} from '../agent/types';
import type {CodeAwareStreamingTextProjection} from '../services/security/codeAwareOutputRegistry';

/**
 * Display-only answer draft: the model's answer text as it streams, before the
 * product has finalized anything. A runtime cannot know that streamed text is
 * the answer until the response ends — the model may still call a tool, a
 * continuation may replace the body, a retry may start over. It therefore
 * revokes what it showed with an `answer_segment_reset` at every such
 * boundary, and every draft event carries the run and the segment it belongs
 * to so a consumer can drop a late event from a revoked segment.
 *
 * The draft is never the answer. The answer reaches clients only from
 * finalization (provisional or final conclusion, then the verdict), which
 * replaces the draft; drafts are live-only and never persisted or replayed.
 */
interface AnswerDraftIdentity {
  runId: string;
  /** Monotone per run; a reset starts the next segment. */
  attempt: number;
}

export interface AnswerDraftStream {
  /** Show answer text in the current segment. */
  token(text: string, timestamp?: number): void;
  /**
   * Revoke the current segment. A boundary that follows no draft text emits
   * nothing: there is nothing to revoke and the next token still starts clean.
   */
  reset(timestamp?: number): void;
  /** Revoke the current segment and show nothing more for the rest of the run. */
  withdraw(timestamp?: number): void;
  readonly attempt: number;
}

export function createAnswerDraftStream(runId: string, emit: (update: StreamingUpdate) => void): AnswerDraftStream {
  let attempt = 0;
  let shown = false;
  let withdrawn = false;
  const reset = (timestamp = Date.now()) => {
    if (!shown) return;
    shown = false;
    attempt += 1;
    emit({type: 'answer_segment_reset', content: {runId, attempt}, timestamp});
  };
  return {
    get attempt() { return attempt; },
    token(text, timestamp = Date.now()) {
      if (!text || withdrawn) return;
      shown = true;
      emit({type: 'answer_token', content: {token: text, runId, attempt}, timestamp});
    },
    reset,
    withdraw(timestamp) {
      withdrawn = true;
      reset(timestamp);
    },
  };
}

/**
 * The draft of answer text that passes an owner projection. A stream cannot
 * redact what it already showed: a value becomes a credential by context that
 * follows it, and a registration can arrive after the text it matches. So the
 * first projection that altered anything, or failed safe, withdraws the draft
 * for the rest of the run, and the finalized answer replaces it. Every call
 * that can release draft text goes through here, including a boundary flush
 * whose output is discarded and a write that released nothing.
 */
export interface ProjectedAnswerDraft {
  /** Project answer text; returns what the draft showed. */
  write(text: string, timestamp?: number): string;
  /** The answer ended: show what the projection still held; returns what the draft showed. */
  finish(timestamp?: number): string;
  /**
   * A segment boundary (a tool call, a new response): revoke the segment and
   * return what the projection still held, which is not part of the answer.
   */
  boundary(timestamp?: number): string;
}

export function createProjectedAnswerDraft(
  draft: AnswerDraftStream,
  projection: CodeAwareStreamingTextProjection | undefined,
): ProjectedAnswerDraft {
  const show = (text: string, timestamp: number | undefined): string => {
    if (projection?.altered) {
      draft.withdraw(timestamp);
      return '';
    }
    if (!text) return '';
    draft.token(text, timestamp);
    return text;
  };
  return {
    write: (text, timestamp) => show(projection ? projection.write(text) : text, timestamp),
    finish: timestamp => show(projection?.flush() ?? '', timestamp),
    boundary: timestamp => {
      draft.reset(timestamp);
      const held = projection?.flush() ?? '';
      if (projection?.altered) draft.withdraw(timestamp);
      return held;
    },
  };
}

/** Text that is never shown, such as a recovery candidate delivered whole by its conclusion. */
export const SILENT_ANSWER_DRAFT: ProjectedAnswerDraft = {write: () => '', finish: () => '', boundary: () => ''};

/** Identity of a draft event, or undefined when it does not carry the contract. */
export function readAnswerDraftIdentity(update: Pick<StreamingUpdate, 'content'>): AnswerDraftIdentity | undefined {
  const content = update.content as unknown;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return undefined;
  const {runId, attempt} = content as Record<string, unknown>;
  return typeof runId === 'string' && runId.length > 0 && Number.isSafeInteger(attempt) && (attempt as number) >= 0
    ? {runId, attempt: attempt as number} : undefined;
}
