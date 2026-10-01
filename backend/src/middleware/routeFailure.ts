// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import type { Request, Response } from 'express';
import { createRequestId, REQUEST_ID_HEADER, requestIdOf } from './requestId';

// body-parser attaches the raw request body to its errors; a malformed JSON
// request can carry a provider key, so it stays out of the log as well.
function loggableError(err: unknown): unknown {
  if (!(err instanceof Error) || !('body' in err)) return err;
  const {body: _requestBody, ...fields} = err as Error & Record<string, unknown>;
  return {...fields, name: err.name, message: err.message, stack: err.stack};
}

interface RouteFailure {
  /** HTTP status; defaults to 500. */
  status?: number;
  /** Stable machine-readable code clients branch on. */
  code: string;
  /** Fixed client-facing text; never derived from the exception. */
  error: string;
  /** Log line prefix, e.g. `[ReportRoutes] Export report error`. */
  logLabel: string;
}

/**
 * Answer a route's caught downstream failure without its message. An
 * exception's message can carry file paths, SQL, provider details or stored
 * text, so the client gets the route's fixed text, a stable code and the
 * request id, while the message and stack go to the server log under that id.
 *
 * Only for arbitrary downstream exceptions: a deliberate validation error our
 * own code produced keeps its user-actionable text in the route's contract.
 */
export function sendRouteFailure(res: Response, failure: RouteFailure, err: unknown): void {
  const status = failure.status ?? 500;
  const requestId = logRouteFailure(res, failure.logLabel, status, failure.code, err);

  // A started response cannot change its status; close it like Express does
  // for an error after the headers went out.
  if (res.headersSent) {
    if (!res.writableEnded) res.destroy();
    return;
  }
  // The success path may already have set attachment or HTML headers.
  res.removeHeader('Content-Disposition');
  res
    .status(status)
    .type('json')
    .set(REQUEST_ID_HEADER, requestId)
    .json({success: false, code: failure.code, error: failure.error, requestId});
}

/** Log a failure with its request id, method and path; returns the request id. */
export function logRouteFailure(
  res: Response,
  logLabel: string,
  status: number,
  code: string,
  err: unknown,
): string {
  const req = res.req as Request | undefined;
  const requestId = req ? requestIdOf(req) : createRequestId();
  console.error(logLabel, {
    requestId,
    method: req?.method,
    path: req?.originalUrl.split('?')[0],
    status,
    code,
    headersSent: res.headersSent,
  }, loggableError(err));
  return requestId;
}
