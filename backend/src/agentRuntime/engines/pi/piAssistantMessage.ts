// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/** Whether a Pi assistant message asked for a tool; its content blocks are the only evidence. */
export function piAssistantMessageHasToolCall(message: {content?: unknown} | undefined): boolean {
  return Array.isArray(message?.content)
    && message.content.some(part => (part as {type?: unknown} | undefined)?.type === 'toolCall');
}
