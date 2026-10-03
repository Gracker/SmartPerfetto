// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { STATUS_CODES } from 'http';
import type { ErrorRequestHandler } from 'express';
import { logRouteFailure, sendRouteFailure } from './routeFailure';

export const UNHANDLED_ERROR_CODE = 'unhandled_error';

function responseStatus(err: unknown): number {
  const {status, statusCode} = (err ?? {}) as {status?: unknown; statusCode?: unknown};
  const candidate = status ?? statusCode;
  return typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 400 && candidate <= 599
    ? candidate
    : 500;
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
export const unhandledErrorHandler: ErrorRequestHandler = (err, _req, res, next) => {
  const status = responseStatus(err);
  // A started response cannot change its status; Express closes the connection.
  if (res.headersSent) {
    logRouteFailure(res, '[UnhandledError]', status, UNHANDLED_ERROR_CODE, err);
    next(err);
    return;
  }
  sendRouteFailure(res, {
    status,
    code: UNHANDLED_ERROR_CODE,
    error: STATUS_CODES[status] ?? (status < 500 ? 'Request failed' : 'Internal Server Error'),
    logLabel: '[UnhandledError]',
  }, err);
};
