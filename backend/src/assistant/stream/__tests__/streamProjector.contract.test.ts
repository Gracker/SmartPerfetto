// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { describe, expect, it } from '@jest/globals';
import type express from 'express';
import { StreamProjector } from '../streamProjector';
import { createDataEnvelope } from '../../../types/dataContract';

class MockSseResponse {
  readonly writes: string[] = [];

  setHeader(_name: string, _value: string): void {
    // No-op for tests.
  }

  write(chunk: string): boolean {
    this.writes.push(String(chunk));
    return true;
  }
}

function parseSsePayload(raw: string): Array<{ event: string; data: any }> {
  const out: Array<{ event: string; data: any }> = [];
  const chunks = raw.split('\n\n').filter(Boolean);
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const eventLine = lines.find((line) => line.startsWith('event:'));
    const dataLine = lines.find((line) => line.startsWith('data:'));
    if (!eventLine || !dataLine) continue;
    const event = eventLine.slice('event:'.length).trim();
    const rawData = dataLine.slice('data:'.length).trim();
    out.push({ event, data: JSON.parse(rawData) });
  }
  return out;
}

describe('StreamProjector SSE Contract', () => {
  it('emits data event contract with envelope payload', () => {
    const projector = new StreamProjector();
    const res = new MockSseResponse();

    const envelope = createDataEnvelope(
      { columns: ['metric'], rows: [[123]] },
      {
        type: 'skill_result',
        source: 'test.stream_projector',
        title: 'test_data',
        skillId: 'test_skill',
        stepId: 'step_a',
        layer: 'list',
        format: 'table',
      }
    );

    projector.broadcastStreamingUpdate(
      'session-1',
      [res as unknown as express.Response],
      {
        type: 'data',
        content: envelope,
        timestamp: Date.now(),
      } as any,
      {
        observability: {
          runId: 'run-1',
          requestId: 'req-1',
          runSequence: 1,
        },
      }
    );

    const parsed = parseSsePayload(res.writes.join(''));
    expect(parsed.length).toBe(1);
    expect(parsed[0].event).toBe('data');
    expect(parsed[0].data.type).toBe('data');
    expect(typeof parsed[0].data.id).toBe('string');
    expect(typeof parsed[0].data.timestamp).toBe('number');
    expect(parsed[0].data.envelope).toBeDefined();
    expect(parsed[0].data.envelope.data.columns).toEqual(['metric']);
    expect(parsed[0].data.runId).toBe('run-1');
    expect(parsed[0].data.requestId).toBe('req-1');
    expect(parsed[0].data.runSequence).toBe(1);
  });

  it('emits conversation_step event contract with generic data payload', () => {
    const projector = new StreamProjector();
    const res = new MockSseResponse();

    projector.broadcastStreamingUpdate(
      'session-2',
      [res as unknown as express.Response],
      {
        type: 'conversation_step',
        id: 'evt-123',
        content: {
          phase: 'thinking',
          role: 'agent',
          text: '正在分析',
        },
        timestamp: Date.now(),
      } as any,
      {
        observability: {
          runId: 'run-2',
          requestId: 'req-2',
          runSequence: 2,
        },
      }
    );

    const parsed = parseSsePayload(res.writes.join(''));
    expect(parsed.length).toBe(1);
    expect(parsed[0].event).toBe('conversation_step');
    expect(parsed[0].data.type).toBe('conversation_step');
    expect(parsed[0].data.id).toBe('evt-123');
    expect(typeof parsed[0].data.timestamp).toBe('number');
    expect(parsed[0].data.data.phase).toBe('thinking');
    expect(parsed[0].data.data.role).toBe('agent');
    expect(parsed[0].data.runId).toBe('run-2');
    expect(parsed[0].data.requestId).toBe('req-2');
    expect(parsed[0].data.runSequence).toBe(2);
  });

  it('emits error event with both error and message fields for client compatibility', () => {
    const projector = new StreamProjector();
    const res = new MockSseResponse();

    projector.sendError(
      res as unknown as express.Response,
      'trace not found',
      {
        runId: 'run-3',
        requestId: 'req-3',
        runSequence: 3,
      }
    );

    const parsed = parseSsePayload(res.writes.join(''));
    expect(parsed.length).toBe(1);
    expect(parsed[0].event).toBe('error');
    expect(parsed[0].data.error).toBe('trace not found');
    expect(parsed[0].data.message).toBe('trace not found');
    expect(parsed[0].data.runId).toBe('run-3');
    expect(parsed[0].data.requestId).toBe('req-3');
    expect(parsed[0].data.runSequence).toBe(3);
  });

  it('replays only buffered events after Last-Event-ID', () => {
    const projector = new StreamProjector();
    const res = new MockSseResponse();

    const replayed = projector.replayBufferedEvents(
      res as unknown as express.Response,
      [
        {seqId: 1, eventType: 'progress', eventData: JSON.stringify({step: 1})},
        {
          seqId: 2,
          eventType: 'analysis_completed',
          eventData: JSON.stringify({reportUrl: '/api/reports/report-a'}),
        },
        {seqId: 3, eventType: 'end', eventData: JSON.stringify({done: true})},
      ],
      1
    );

    expect(replayed).toBe(2);
    const raw = res.writes.join('');
    expect(raw).toContain('id: 2\n');
    expect(raw).toContain('event: analysis_completed\n');
    expect(raw).toContain('id: 3\n');
    expect(raw).toContain('event: end\n');
    expect(raw).not.toContain('id: 1\n');
  });
});
