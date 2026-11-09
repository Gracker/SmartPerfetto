// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Inline `<think>` reasoning that a compatible model streams inside its answer
 * text. A draft must never show it, and a tag can split across deltas, so the
 * filter keeps state for one response.
 */
export interface AnswerReasoningFilterState {
  insideThink: boolean;
  pendingTagPrefix: string;
}

export function createAnswerReasoningFilterState(): AnswerReasoningFilterState {
  return {
    insideThink: false,
    pendingTagPrefix: '',
  };
}

const CLOSE_TAG = '</think>';
const OPEN_TAG = '<think>';
const LONGEST_TAG = CLOSE_TAG.length;

function isReasoningTagPrefix(value: string): boolean {
  const lower = value.toLowerCase();
  return OPEN_TAG.startsWith(lower) || CLOSE_TAG.startsWith(lower);
}

/**
 * The part of one answer delta that is outside inline reasoning. Linear in the
 * delta: only a `<` is examined, against at most one tag's length of text.
 */
export function filterAnswerReasoningDelta(delta: string, state: AnswerReasoningFilterState): string {
  if (!state.pendingTagPrefix && !state.insideThink && !delta.includes('<')) return delta;
  const input = `${state.pendingTagPrefix}${delta}`;
  state.pendingTagPrefix = '';
  let output = '';
  let index = 0;

  while (index < input.length) {
    const tagStart = input.indexOf('<', index);
    if (tagStart === -1) {
      if (!state.insideThink) output += input.slice(index);
      break;
    }
    if (!state.insideThink) output += input.slice(index, tagStart);
    const candidate = input.slice(tagStart, tagStart + LONGEST_TAG).toLowerCase();
    if (candidate.startsWith(OPEN_TAG)) {
      state.insideThink = true;
      index = tagStart + OPEN_TAG.length;
    } else if (candidate === CLOSE_TAG) {
      state.insideThink = false;
      index = tagStart + CLOSE_TAG.length;
    } else if (isReasoningTagPrefix(candidate)) {
      state.pendingTagPrefix = input.slice(tagStart);
      break;
    } else {
      if (!state.insideThink) output += '<';
      index = tagStart + 1;
    }
  }

  return output;
}
