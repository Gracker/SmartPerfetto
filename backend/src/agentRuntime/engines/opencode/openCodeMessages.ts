// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/** Readers for OpenCode session messages, shared by the answer session and the no-tool transport. */

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function getOpenCodeMessageRole(value: Record<string, unknown>): string | undefined {
  if (typeof value.role === 'string') return value.role;
  const info = isRecord(value.info) ? value.info : undefined;
  return typeof info?.role === 'string' ? info.role : undefined;
}

function collectOpenCodeAssistantMessages(value: unknown, output: Record<string, unknown>[]): void {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) collectOpenCodeAssistantMessages(item, output);
    return;
  }
  if (!isRecord(value)) return;
  if (getOpenCodeMessageRole(value) === 'assistant') {
    output.push(value);
    return;
  }
  for (const key of ['data', 'message', 'messages', 'response', 'result']) {
    if (key in value) collectOpenCodeAssistantMessages(value[key], output);
  }
}

export function getOpenCodeAssistantMessages(value: unknown): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  collectOpenCodeAssistantMessages(value, messages);
  return messages;
}

export function getOpenCodeAssistantMessageId(message: Record<string, unknown>): string | undefined {
  const info = isRecord(message.info) ? message.info : message;
  return typeof info.id === 'string'
    ? info.id
    : typeof message.id === 'string'
      ? message.id
      : undefined;
}
