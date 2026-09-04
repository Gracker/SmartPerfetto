// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Collects a model's between-tool-call reasoning so it can be shown once, at a
 * boundary, instead of per token.
 *
 * Runtimes learn that a stretch of model text is reasoning rather than the
 * answer, but they learn it at different moments: the Claude bridge finds out
 * when a `tool_use` block starts, and the OpenAI runtime knows it up front
 * because the plan is not complete yet. Both then need the same thing — hold
 * the fragments, and at the boundary turn them into one readable line or
 * nothing at all.
 *
 * Emitting per delta would bury the process view in fragments; emitting
 * nothing, which is what the OpenAI path did, drops the model's own account of
 * what it is trying. That account is the difference between a tool log and a
 * process a reader can follow.
 */

/** Below this a fragment is punctuation or a stray token, not a thought. */
const MIN_THOUGHT_CHARS = 12;

/** One line in the process view. Longer reasoning is truncated, not split. */
const MAX_THOUGHT_CHARS = 220;

function normalize(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^\s*#{1,6}\s+/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class ReasoningThoughtBuffer {
  private pending = '';

  append(fragment: string): void {
    if (!fragment) return;
    // Bound the raw buffer too: a runaway turn must not grow without limit
    // before anyone flushes it.
    if (this.pending.length > MAX_THOUGHT_CHARS * 8) return;
    this.pending += fragment;
  }

  hasPending(): boolean {
    return this.pending.trim().length > 0;
  }

  /**
   * Take the buffered reasoning as one readable line, or an empty string when
   * there is nothing worth a line. Always clears.
   */
  flush(): string {
    const normalized = normalize(this.pending);
    this.pending = '';
    if (normalized.length < MIN_THOUGHT_CHARS) return '';
    return normalized.length > MAX_THOUGHT_CHARS
      ? `${normalized.slice(0, MAX_THOUGHT_CHARS - 1)}…`
      : normalized;
  }
}
