// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  SSE_RING_BUFFER_SIZE,
  type BufferedSseEvent,
} from './streamProjector';

export interface SessionSseReplayState {
  sseEventSeq: number;
  sseEventBuffer: BufferedSseEvent[];
}

export const TERMINAL_SSE_EVENT_TYPES = new Set([
  'analysis_completed',
  'analysis_cancelled',
  'error',
  'end',
]);

export function isTerminalSseEvent(eventType: string, eventData?: string): boolean {
  if (eventType !== 'analysis_completed') return TERMINAL_SSE_EVENT_TYPES.has(eventType);
  if (!eventData) return true;
  try {
    const payload = JSON.parse(eventData) as Record<string, unknown>;
    const data = payload.data && typeof payload.data === 'object'
      ? payload.data as Record<string, unknown>
      : payload;
    return data.sourceEnrichmentPending !== true;
  } catch {
    return true;
  }
}

export function parseLastEventId(
  headerValue: unknown,
  legacyQueryValue?: unknown
): number | null {
  const raw = headerValue ?? legacyQueryValue;
  if (Array.isArray(raw)) {
    return parseLastEventId(raw[0]);
  }
  if (raw === undefined || raw === null || raw === '') {
    return null;
  }
  const parsed = Number.parseInt(String(raw), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

export function appendReplayableSseEvent(
  state: SessionSseReplayState,
  eventType: string,
  payload: unknown,
  maxBufferedEvents = SSE_RING_BUFFER_SIZE
): BufferedSseEvent {
  const event: BufferedSseEvent = {
    seqId: ++state.sseEventSeq,
    eventType,
    eventData: JSON.stringify(payload),
  };
  state.sseEventBuffer.push(event);
  if (state.sseEventBuffer.length > maxBufferedEvents) {
    state.sseEventBuffer.splice(
      0,
      state.sseEventBuffer.length - maxBufferedEvents
    );
  }
  return event;
}

export function hasTerminalReplayAfter(
  state: SessionSseReplayState,
  lastEventId: number
): boolean {
  return state.sseEventBuffer.some(
    event =>
      event.seqId > lastEventId && isTerminalSseEvent(event.eventType, event.eventData)
  );
}
