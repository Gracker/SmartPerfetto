// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {
  appendReplayableSseEvent,
  hasTerminalReplayAfter,
  parseLastEventId,
  type SessionSseReplayState,
} from '../sessionSseReplay';

function createState(): SessionSseReplayState {
  return {
    sseEventSeq: 0,
    sseEventBuffer: [],
  };
}

describe('session SSE replay state', () => {
  it('prefers Last-Event-ID header over legacy query cursor', () => {
    expect(parseLastEventId('42', '7')).toBe(42);
    expect(parseLastEventId(undefined, '7')).toBe(7);
    expect(parseLastEventId(['9'])).toBe(9);
    expect(parseLastEventId('not-a-number', '7')).toBeNull();
  });

  it('assigns monotonic cursors and stores JSON event data', () => {
    const state = createState();

    const first = appendReplayableSseEvent(state, 'progress', {step: 1});
    const second = appendReplayableSseEvent(state, 'analysis_completed', {
      reportUrl: '/api/reports/report-a',
    });

    expect(first.seqId).toBe(1);
    expect(second.seqId).toBe(2);
    expect(state.sseEventSeq).toBe(2);
    expect(JSON.parse(state.sseEventBuffer[1].eventData)).toEqual({
      reportUrl: '/api/reports/report-a',
    });
  });

  it('detects terminal events that must stop reconnect replay', () => {
    const state = createState();
    appendReplayableSseEvent(state, 'progress', {step: 1});
    appendReplayableSseEvent(state, 'analysis_completed', {
      reportUrl: '/api/reports/report-a',
    });
    appendReplayableSseEvent(state, 'end', {timestamp: 123});

    expect(hasTerminalReplayAfter(state, 0)).toBe(true);
    expect(hasTerminalReplayAfter(state, 2)).toBe(true);
    expect(hasTerminalReplayAfter(state, 3)).toBe(false);
  });

  it('trims old replay events to the configured ring buffer size', () => {
    const state = createState();

    appendReplayableSseEvent(state, 'progress', {step: 1}, 2);
    appendReplayableSseEvent(state, 'progress', {step: 2}, 2);
    appendReplayableSseEvent(state, 'progress', {step: 3}, 2);

    expect(state.sseEventBuffer.map(event => event.seqId)).toEqual([2, 3]);
  });
});
