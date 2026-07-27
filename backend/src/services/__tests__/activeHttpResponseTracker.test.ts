// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import {EventEmitter} from 'events';
import {describe, expect, it, jest} from '@jest/globals';
import type {Request, Response} from 'express';
import {createActiveHttpResponseTracker} from '../activeHttpResponseTracker';

function responseFixture(contentType = '') {
  const emitter = new EventEmitter();
  const end = jest.fn(() => emitter.emit('finish'));
  return {
    emitter,
    end,
    response: Object.assign(emitter, {
      end,
      getHeader: jest.fn(() => contentType),
    }) as unknown as Response,
  };
}

describe('createActiveHttpResponseTracker', () => {
  it('ends active SSE responses during runtime shutdown', () => {
    const tracker = createActiveHttpResponseTracker();
    const fixture = responseFixture('text/event-stream; charset=utf-8');
    const next = jest.fn();
    tracker.middleware(
      {headers: {accept: 'text/event-stream'}} as Request,
      fixture.response,
      next,
    );

    expect(tracker.activeCount()).toBe(1);
    expect(tracker.closeEventStreams()).toBe(1);
    expect(fixture.end).toHaveBeenCalledTimes(1);
    expect(tracker.activeCount()).toBe(0);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('leaves ordinary in-flight HTTP responses to the server grace deadline', () => {
    const tracker = createActiveHttpResponseTracker();
    const fixture = responseFixture('application/json');
    tracker.middleware(
      {headers: {accept: 'application/json'}} as Request,
      fixture.response,
      jest.fn(),
    );

    expect(tracker.closeEventStreams()).toBe(0);
    expect(fixture.end).not.toHaveBeenCalled();
    fixture.emitter.emit('close');
    expect(tracker.activeCount()).toBe(0);
  });
});
