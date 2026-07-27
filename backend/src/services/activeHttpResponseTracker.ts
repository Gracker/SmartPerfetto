// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type {RequestHandler, Response} from 'express';

interface TrackedResponse {
  acceptsEventStream: boolean;
  response: Response;
}

export interface ActiveHttpResponseTracker {
  middleware: RequestHandler;
  closeEventStreams(): number;
  activeCount(): number;
}

function isEventStream(entry: TrackedResponse): boolean {
  const contentType = String(entry.response.getHeader('content-type') || '');
  return entry.acceptsEventStream || contentType.toLowerCase().includes('text/event-stream');
}

export function createActiveHttpResponseTracker(): ActiveHttpResponseTracker {
  const active = new Map<Response, TrackedResponse>();
  const middleware: RequestHandler = (request, response, next) => {
    const tracked = {
      acceptsEventStream: String(request.headers.accept || '')
        .toLowerCase()
        .includes('text/event-stream'),
      response,
    };
    active.set(response, tracked);
    const remove = () => active.delete(response);
    response.once('finish', remove);
    response.once('close', remove);
    next();
  };

  return {
    middleware,
    closeEventStreams(): number {
      let closed = 0;
      for (const entry of active.values()) {
        if (!isEventStream(entry)) continue;
        closed++;
        entry.response.end();
      }
      return closed;
    },
    activeCount(): number {
      return active.size;
    },
  };
}
