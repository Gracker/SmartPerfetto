// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {SILENT_ANSWER_DRAFT, type AnswerDraftStream, type ProjectedAnswerDraft} from '../../answerDraftStream';
import {createAnswerReasoningFilterState, filterAnswerReasoningDelta} from '../../answerReasoningFilter';
import type {PiAgentCoreEvent} from './piAgentCoreRuntime';
import {piAssistantMessageHasToolCall} from './piAssistantMessage';

/**
 * How long the opening text of a response is held so a tool call arriving just
 * behind it never reaches the screen. The window is fixed from the first delta,
 * not restarted by each delta: a steadily streaming answer still shows at once.
 */
const ANSWER_TEXT_HOLD_MS = 200;

export interface PiAnswerDraftController {
  /** Start one provider attempt; whatever the previous attempt showed is revoked. */
  beginAttempt(draft: ProjectedAnswerDraft): void;
  onEvent(event: PiAgentCoreEvent): void;
  /** Something else replaces the current body: revoke what is shown or held. */
  boundary(): void;
  /** The attempt's prompt returned: show the rest of the answer it ended on. */
  finish(): void;
  /** The run left the provider; release the timer and show nothing more. */
  dispose(): void;
}

/** The answer text of one Pi delta, only when its content block really is a text block. */
function readAnswerTextDelta(assistantEvent: Record<string, unknown>): {index: number; delta: string} | undefined {
  const {contentIndex, delta, partial} = assistantEvent;
  if (typeof contentIndex !== 'number' || typeof delta !== 'string') return undefined;
  const content = (partial as {content?: unknown} | undefined)?.content;
  const block = Array.isArray(content) ? content[contentIndex] as {type?: unknown} | undefined : undefined;
  return block?.type === 'text' ? {index: contentIndex, delta} : undefined;
}

function readAssistantMessage(message: unknown): Record<string, unknown> | undefined {
  const record = message as Record<string, unknown> | undefined;
  return record?.role === 'assistant' ? record : undefined;
}

/** Only a response that ended naturally without calling a tool can be the answer. */
function responseCanBeAnswer(message: Record<string, unknown>): boolean {
  return !piAssistantMessageHasToolCall(message) && (message.stopReason === 'stop' || message.stopReason === 'length');
}

/**
 * Turns the Pi Agent event stream into the display-only answer draft described
 * in `answerDraftStream.ts`. Only `text_delta` reaches the draft: thinking and
 * tool-call JSON are separate block types, and text a response wrote before
 * calling a tool is revoked. Nothing here may disturb the Agent loop or the
 * timer callback, so a projection failure withdraws the draft instead of
 * throwing.
 */
export function createPiAnswerDraftController(input: {
  answerDraft: AnswerDraftStream;
  isActive: () => boolean;
}): PiAnswerDraftController {
  let draft: ProjectedAnswerDraft = SILENT_ANSWER_DRAFT;
  let held = '';
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let streaming = false;
  let toolCallSeen = false;
  let lastTextIndex: number | undefined;
  let reasoning = createAnswerReasoningFilterState();
  let disposed = false;

  const guarded = (action: () => void): void => {
    try {
      action();
    } catch {
      draft = SILENT_ANSWER_DRAFT;
      try { input.answerDraft.withdraw(); } catch { /* The finalized answer replaces the draft. */ }
    }
  };

  const clearHold = (): void => {
    if (holdTimer !== undefined) clearTimeout(holdTimer);
    holdTimer = undefined;
  };

  const resetResponse = (): void => {
    clearHold();
    held = '';
    streaming = false;
    toolCallSeen = false;
    lastTextIndex = undefined;
    reasoning = createAnswerReasoningFilterState();
  };

  const discard = (): void => {
    resetResponse();
    guarded(() => draft.boundary());
  };

  const release = (): void => {
    clearHold();
    streaming = true;
    if (!held) return;
    const text = held;
    held = '';
    guarded(() => draft.write(text));
  };

  const onTextDelta = (index: number, delta: string): void => {
    const visible = filterAnswerReasoningDelta(delta, reasoning);
    if (!visible) return;
    // The final answer joins text blocks the same way.
    const text = lastTextIndex !== undefined && lastTextIndex !== index ? `\n${visible}` : visible;
    lastTextIndex = index;
    if (streaming) {
      guarded(() => draft.write(text));
      return;
    }
    held += text;
    holdTimer ??= setTimeout(() => {
      holdTimer = undefined;
      if (input.isActive()) release();
    }, ANSWER_TEXT_HOLD_MS);
  };

  const onMessageUpdate = (assistantEvent: Record<string, unknown>): void => {
    if (assistantEvent.type === 'toolcall_start') {
      discard();
      toolCallSeen = true;
      return;
    }
    if (assistantEvent.type !== 'text_delta' || toolCallSeen) return;
    const text = readAnswerTextDelta(assistantEvent);
    if (text) onTextDelta(text.index, text.delta);
  };

  return {
    beginAttempt(next) {
      discard();
      draft = next;
    },
    onEvent(event) {
      if (disposed) return;
      if (event.type === 'message_start') {
        if (readAssistantMessage(event.message)) discard();
      } else if (event.type === 'message_update') {
        const assistantEvent = event.assistantMessageEvent;
        if (assistantEvent && typeof assistantEvent === 'object') onMessageUpdate(assistantEvent as Record<string, unknown>);
      } else if (event.type === 'message_end') {
        const message = readAssistantMessage(event.message);
        if (message) {
          if (responseCanBeAnswer(message)) release(); else discard();
        }
      } else if (event.type === 'tool_execution_start') {
        discard();
      }
    },
    boundary: discard,
    finish() {
      if (disposed) return;
      release();
      guarded(() => draft.finish());
    },
    dispose() {
      disposed = true;
      clearHold();
      held = '';
    },
  };
}
