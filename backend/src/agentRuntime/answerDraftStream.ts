// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {StreamingUpdate} from '../agent/types';

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
  readonly attempt: number;
}

export function createAnswerDraftStream(runId: string, emit: (update: StreamingUpdate) => void): AnswerDraftStream {
  let attempt = 0;
  let shown = false;
  return {
    get attempt() { return attempt; },
    token(text, timestamp = Date.now()) {
      if (!text) return;
      shown = true;
      emit({type: 'answer_token', content: {token: text, runId, attempt}, timestamp});
    },
    reset(timestamp = Date.now()) {
      if (!shown) return;
      shown = false;
      attempt += 1;
      emit({type: 'answer_segment_reset', content: {runId, attempt}, timestamp});
    },
  };
}

/** Identity of a draft event, or undefined when it does not carry the contract. */
export function readAnswerDraftIdentity(update: Pick<StreamingUpdate, 'content'>): AnswerDraftIdentity | undefined {
  const content = update.content as unknown;
  if (!content || typeof content !== 'object' || Array.isArray(content)) return undefined;
  const {runId, attempt} = content as Record<string, unknown>;
  return typeof runId === 'string' && runId.length > 0 && Number.isSafeInteger(attempt) && (attempt as number) >= 0
    ? {runId, attempt: attempt as number} : undefined;
}
