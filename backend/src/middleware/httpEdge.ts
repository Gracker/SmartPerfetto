// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * The browser-facing policy the server applies before any route: exact-origin
 * CORS, the keyless-mode Host check against DNS rebinding, and the WebSocket
 * upgrade dispatch, which skips Express and so has to apply that Host check
 * itself. `index.ts` mounts these; they live here so tests run them as served.
 */

import cors from 'cors';
import type { RequestHandler } from 'express';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { isKeylessLocalMode } from '../config';
import {
  hostnameOfHostHeader,
  isCorsOriginAllowed,
  isLoopbackRequestHostname,
} from '../security/requestOriginPolicy';
import { handleTraceProcessorProxyUpgrade, rejectUpgrade } from '../routes/traceProcessorProxyRoutes';
import { REQUEST_ID_HEADER, requestIdOf } from './requestId';

/** Exact-origin CORS; port-only matching would permit DNS rebinding. */
export function createCorsMiddleware(allowedOrigins: ReadonlySet<string>): RequestHandler {
  return cors({
    origin: (requestOrigin, callback) => {
      // No Origin header (server-to-server, curl, etc.) → allow
      if (!requestOrigin) return callback(null, true);
      if (isCorsOriginAllowed(requestOrigin, allowedOrigins)) return callback(null, true);
      callback(new Error(`CORS blocked: ${requestOrigin}`));
    },
    credentials: true,
    // A cross-origin page can read only the response headers listed here.
    exposedHeaders: [REQUEST_ID_HEADER],
  });
}

export const UNTRUSTED_KEYLESS_HOST = 'Untrusted Host in local keyless mode';

/** In keyless local mode only a loopback Host is trusted, even though the process listens on loopback. */
export function isUntrustedKeylessHost(hostname: string): boolean {
  return isKeylessLocalMode() && !isLoopbackRequestHostname(hostname);
}

export const rejectUntrustedKeylessHost: RequestHandler = (req, res, next) => {
  if (isUntrustedKeylessHost(req.hostname)) {
    res.status(403).json({success: false, error: UNTRUSTED_KEYLESS_HOST});
    return;
  }
  next();
};

/**
 * The server's `upgrade` listener: every upgrade is tunnelled or answered with
 * an HTTP status. It runs synchronously outside Express, before any
 * authentication, so nothing a client sends may escape it: an uncaught
 * exception here shuts the backend down.
 */
export function dispatchUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  allowedOrigins: ReadonlySet<string>,
): void {
  // The HTTP server detaches its own error listener from an upgraded socket;
  // this one owns it for the whole upgrade, rejected or tunnelled.
  socket.on('error', () => {});
  try {
    if (isUntrustedKeylessHost(hostnameOfHostHeader(req.headers.host))) {
      rejectUpgrade(socket, 403, UNTRUSTED_KEYLESS_HOST);
      return;
    }
    if (handleTraceProcessorProxyUpgrade(req, socket, head, allowedOrigins)) return;
    rejectUpgrade(socket, 404, 'No WebSocket endpoint at this path');
  } catch (error) {
    console.error('[HttpEdge] WebSocket upgrade dispatch failed', {requestId: requestIdOf(req)}, error);
    rejectUpgrade(socket, 400, 'Bad WebSocket upgrade request');
  }
}
