// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import type { IncomingMessage } from 'http';
import type { RequestHandler } from 'express';
import { getHeaderValue, sanitizeContextId } from './requestHeaders';

export const REQUEST_ID_HEADER = 'X-Request-Id';

/** Caller headers that may carry a correlation id, in precedence order. */
const CALLER_REQUEST_ID_HEADERS = ['x-request-id', 'x-correlation-id', 'x-amzn-trace-id'] as const;

const requestIds = new WeakMap<IncomingMessage, string>();

export const createRequestId = (): string =>
  `req-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;

function callerRequestId(req: IncomingMessage): string {
  for (const name of CALLER_REQUEST_ID_HEADERS) {
    const id = sanitizeContextId(getHeaderValue(req, name));
    if (id) return id;
  }
  return '';
}

/**
 * The one id of this request: the caller's first sanitized correlation header,
 * else a new id. It is resolved once and remembered, so authentication (which
 * runs at the API mount and again inside routers), routes, the error handler
 * and the WebSocket upgrade path all see the same value.
 */
export function requestIdOf(req: IncomingMessage): string {
  let id = requestIds.get(req);
  if (!id) {
    id = callerRequestId(req) || createRequestId();
    requestIds.set(req, id);
  }
  return id;
}

/** Mounted before body parsing so every response, including early failures, carries the id. */
export const requestIdMiddleware: RequestHandler = (req, res, next) => {
  res.setHeader(REQUEST_ID_HEADER, requestIdOf(req));
  next();
};
