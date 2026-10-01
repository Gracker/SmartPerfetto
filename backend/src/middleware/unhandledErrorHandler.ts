// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { STATUS_CODES } from 'http';
import type { ErrorRequestHandler } from 'express';
import { getRequestContext, resolveRequestId } from './auth';

export const UNHANDLED_ERROR_CODE = 'unhandled_error';

function responseStatus(err: unknown): number {
  const {status, statusCode} = (err ?? {}) as {status?: unknown; statusCode?: unknown};
  const candidate = status ?? statusCode;
  return typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599
    ? candidate
    : 500;
}

// body-parser attaches the raw request body to its errors; a malformed JSON
// request can carry a provider key, so it stays out of the log as well.
function loggableError(err: unknown): unknown {
  if (!(err instanceof Error) || !('body' in err)) return err;
  const {body: _requestBody, ...fields} = err as Error & Record<string, unknown>;
  return {...fields, name: err.name, message: err.message, stack: err.stack};
}

/**
 * Last-resort handler for errors no route answered itself. Routes with a
 * deliberate error contract keep it; this only covers what reaches here.
 *
 * The response is fixed in every NODE_ENV: an error's message can carry file
 * paths, SQL, provider details or stored text, and its stack reveals server
 * paths, so both stay in the server log. A 4xx message is withheld too: a JSON
 * parse error can quote the request body. The request id ties the response to
 * the log line.
 */
export const unhandledErrorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // Keep an id a route already sent, then the authenticated one; body parsing
  // fails before authentication, so fall back to the caller's own header.
  const sentRequestId = res.getHeader('X-Request-Id');
  const requestId = (typeof sentRequestId === 'string' && sentRequestId)
    || getRequestContext(req)?.requestId
    || resolveRequestId(req);
  const status = responseStatus(err);
  console.error('[UnhandledError]', {
    requestId,
    method: req.method,
    path: req.originalUrl.split('?')[0],
    status,
    headersSent: res.headersSent,
  }, loggableError(err));

  // A started response cannot change its status; Express closes the connection.
  if (res.headersSent) {
    next(err);
    return;
  }

  res
    .status(status)
    .set('X-Request-Id', requestId)
    .json({
      success: false,
      code: UNHANDLED_ERROR_CODE,
      error: STATUS_CODES[status] ?? (status < 500 ? 'Request failed' : 'Internal Server Error'),
      requestId,
    });
};
