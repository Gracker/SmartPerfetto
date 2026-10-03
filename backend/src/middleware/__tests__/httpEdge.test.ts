// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import http from 'http';
import net from 'net';
import request from 'supertest';
import { ENTERPRISE_FEATURE_FLAG_ENV } from '../../config';
import { normalizeCorsOrigins } from '../../security/requestOriginPolicy';
import * as traceProcessorProxy from '../../routes/traceProcessorProxyRoutes';
import { REJECTED_UPGRADE_LINGER_MS } from '../../routes/traceProcessorProxyRoutes';
import { REQUEST_ID_HEADER, requestIdMiddleware } from '../requestId';
import { createCorsMiddleware, dispatchUpgrade, UNTRUSTED_KEYLESS_HOST } from '../httpEdge';

const FRONTEND_ORIGIN = 'http://localhost:10000';
const ALLOWED_ORIGINS = normalizeCorsOrigins([FRONTEND_ORIGIN]);
const ENV_KEYS = ['SMARTPERFETTO_API_KEY', ENTERPRISE_FEATURE_FLAG_ENV] as const;
const originalEnv = new Map(ENV_KEYS.map(key => [key, process.env[key]]));

beforeEach(() => {
  delete process.env.SMARTPERFETTO_API_KEY;
  process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'false';
});

afterAll(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('createCorsMiddleware', () => {
  /** Mirrors index.ts: the request id first, then CORS. */
  function makeApp(): express.Express {
    const app = express();
    app.use(requestIdMiddleware);
    app.use(createCorsMiddleware(ALLOWED_ORIGINS));
    app.get('/api/probe', (_req, res) => {
      res.json({ ok: true });
    });
    return app;
  }

  it('lets an allowed cross-origin page read the request id header', async () => {
    const res = await request(makeApp()).get('/api/probe')
      .set('Origin', FRONTEND_ORIGIN)
      .set('X-Request-Id', 'cross-origin-1');

    expect(res.status).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe(FRONTEND_ORIGIN);
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    // A browser hides any non-safelisted response header not named here.
    const exposed = String(res.headers['access-control-expose-headers'] ?? '')
      .split(',').map(name => name.trim().toLowerCase());
    expect(exposed).toContain(REQUEST_ID_HEADER.toLowerCase());
    expect(res.headers[REQUEST_ID_HEADER.toLowerCase()]).toBe('cross-origin-1');
  });

  it('admits the preflight of an allowed origin', async () => {
    const res = await request(makeApp()).options('/api/probe')
      .set('Origin', FRONTEND_ORIGIN)
      .set('Access-Control-Request-Method', 'GET')
      .set('Access-Control-Request-Headers', 'x-request-id');

    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(FRONTEND_ORIGIN);
  });

  it('grants nothing to an origin outside the list', async () => {
    const res = await request(makeApp()).get('/api/probe').set('Origin', 'http://localhost:10001');

    expect(res.headers['access-control-allow-origin']).toBeUndefined();
    expect(res.headers['access-control-expose-headers']).toBeUndefined();
  });
});

describe('dispatchUpgrade', () => {
  let server: http.Server;
  let port: number;
  const serverSockets: net.Socket[] = [];

  beforeAll(async () => {
    server = http.createServer((_req, res) => res.end());
    server.on('connection', socket => serverSockets.push(socket));
    server.on('upgrade', (req, socket, head) => dispatchUpgrade(req, socket, head, ALLOWED_ORIGINS));
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
  });

  afterEach(() => {
    for (const socket of serverSockets.splice(0)) socket.destroy();
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  /**
   * Sends a raw upgrade from a peer that never closes its side unless
   * `peerCloses`, so only the server can end the connection. Resolves with the
   * response text and whether the server's socket closed.
   */
  async function rawUpgrade(
    host: string,
    path: string,
    {peerCloses = false}: {peerCloses?: boolean} = {},
  ): Promise<{response: string; serverClosed: boolean}> {
    const acceptedSocket = new Promise<net.Socket>(resolve => server.once('connection', resolve));
    const client = net.connect({host: '127.0.0.1', port, allowHalfOpen: true});
    client.on('error', () => {});
    let response = '';
    client.on('data', chunk => {
      response += chunk.toString('utf8');
      if (peerCloses) client.end();
    });
    const accepted = await acceptedSocket;
    const serverClosed = new Promise<boolean>(resolve => {
      const deadline = setTimeout(() => resolve(false), REJECTED_UPGRADE_LINGER_MS + 2_000);
      accepted.once('close', () => {clearTimeout(deadline); resolve(true);});
    });
    client.write([
      `GET ${path} HTTP/1.1`, `Host: ${host}`, 'Connection: Upgrade', 'Upgrade: websocket',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version: 13', '', '',
    ].join('\r\n'));
    const closed = await serverClosed;
    client.destroy();
    return {response, serverClosed: closed};
  }

  it('answers a DNS-rebinding Host with 403 and releases the socket', async () => {
    const {response, serverClosed} = await rawUpgrade(`rebind.attacker.example:${port}`, '/api/tp/lease-1/websocket');

    expect(response.split('\r\n')[0]).toBe('HTTP/1.1 403 Forbidden');
    expect(response.endsWith(`\r\n\r\n${UNTRUSTED_KEYLESS_HOST}`)).toBe(true);
    expect(serverClosed).toBe(true);
  });

  it('lets a loopback Host through to the trace processor proxy', async () => {
    // A malformed lease id is the proxy's own 400, so the request passed the Host check.
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const {response, serverClosed} = await rawUpgrade(host, '/api/tp/%E0/websocket');
      expect({host, status: response.split('\r\n')[0]}).toEqual({host, status: 'HTTP/1.1 400 Bad Request'});
      expect(serverClosed).toBe(true);
    }
  });

  it('answers an upgrade no endpoint takes with 404 instead of dropping it', async () => {
    const {response, serverClosed} = await rawUpgrade(`127.0.0.1:${port}`, '/api/agent/v1/no-such-socket');

    expect(response.split('\r\n')[0]).toBe('HTTP/1.1 404 Not Found');
    expect(serverClosed).toBe(true);
  });

  // These request targets pass Node's HTTP parser but are not parseable URLs.
  // An exception from the synchronous upgrade listener would shut the backend
  // down before any authentication; with an operator key there is no Host
  // check in front of it, so any network peer could send one.
  const MALFORMED_TARGETS = ['//[', '//[::1', 'http://[', '//:99999', '//%', '///'];

  it.each([false, true])('answers malformed request targets with 400 (operator key=%s)', async operatorKey => {
    if (operatorKey) process.env.SMARTPERFETTO_API_KEY = 'operator-key-for-malformed-target';
    for (const target of MALFORMED_TARGETS) {
      const {response, serverClosed} = await rawUpgrade(`127.0.0.1:${port}`, target, {peerCloses: true});
      expect({target, status: response.split('\r\n')[0]}).toEqual({target, status: 'HTTP/1.1 400 Bad Request'});
      expect(response.endsWith('\r\n\r\nMalformed request target')).toBe(true);
      expect(serverClosed).toBe(true);
    }
    // The server still serves upgrades afterwards.
    const {response} = await rawUpgrade(`127.0.0.1:${port}`, '/api/agent/v1/no-such-socket', {peerCloses: true});
    expect(response.split('\r\n')[0]).toBe('HTTP/1.1 404 Not Found');
  });

  it('answers any exception from an upgrade handler with 400 instead of throwing', async () => {
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(traceProcessorProxy, 'handleTraceProcessorProxyUpgrade').mockImplementation(() => {
      throw new Error('handler-canary');
    });
    const {response, serverClosed} = await rawUpgrade(`127.0.0.1:${port}`, '/api/tp/lease-1/websocket',
      {peerCloses: true});

    expect(response.split('\r\n')[0]).toBe('HTTP/1.1 400 Bad Request');
    expect(response).not.toContain('handler-canary');
    expect(serverClosed).toBe(true);
    expect(errorLog.mock.calls.flat().map(value => (value instanceof Error ? value.message : '')))
      .toContain('handler-canary');
  });

  it('applies the Host check only in keyless local mode', async () => {
    process.env.SMARTPERFETTO_API_KEY = 'operator-key-for-host-check';
    const {response} = await rawUpgrade(`rebind.attacker.example:${port}`, '/api/tp/%E0/websocket');

    expect(response.split('\r\n')[0]).toBe('HTTP/1.1 400 Bad Request');
  });
});
