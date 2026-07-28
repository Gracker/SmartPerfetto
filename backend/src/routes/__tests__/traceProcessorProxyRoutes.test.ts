// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import fs from 'fs/promises';
import http, { type Server } from 'http';
import type { Socket as NetSocket } from 'net';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { ENTERPRISE_FEATURE_FLAG_ENV } from '../../config';
import { ENTERPRISE_DB_PATH_ENV, openEnterpriseDb } from '../../services/enterpriseDb';
import type { EnterpriseRepositoryScope } from '../../services/enterpriseRepository';
import {
  getTraceProcessorLeaseStore,
  setTraceProcessorLeaseStoreForTests,
  type TraceProcessorLeaseRecord,
} from '../../services/traceProcessorLeaseStore';
import { setTraceProcessorServiceForTests } from '../../services/traceProcessorService';
import {
  TRACE_PROCESSOR_CAPABILITY_SECRET_ENV,
  issueTraceProcessorProxyCapability,
  resetTraceProcessorProxyCapabilitiesForTests,
} from '../../services/traceProcessorProxyCapability';
import traceProcessorProxyRoutes, {
  handleTraceProcessorProxyUpgrade,
} from '../traceProcessorProxyRoutes';

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  trustedHeaders: process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS,
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
  apiKey: process.env.SMARTPERFETTO_API_KEY,
  capabilitySecret: process.env[TRACE_PROCESSOR_CAPABILITY_SECRET_ENV],
};

const scope: EnterpriseRepositoryScope = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  userId: 'user-a',
};

let tmpDir: string;
let dbPath: string;
let upstreamServer: Server;
let upstreamSockets: Set<NetSocket>;
let upstreamPort: number;
let lease: TraceProcessorLeaseRecord;
let queryRawMock: jest.MockedFunction<(traceId: string, body: Buffer, options?: any) => Promise<Buffer>>;
let restartLeaseMock: jest.MockedFunction<(
  traceId: string,
  leaseId: string,
  mode: string,
  scope: EnterpriseRepositoryScope,
) => Promise<unknown>>;

function restoreEnvValue(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

function makeApp(): express.Express {
  const app = express();
  app.use('/api/tp', traceProcessorProxyRoutes);
  return app;
}

function ssoHeaders(req: request.Test, workspaceId = 'workspace-a'): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', 'user-a')
    .set('X-SmartPerfetto-SSO-Email', 'user-a@example.test')
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', workspaceId)
    .set('X-SmartPerfetto-SSO-Roles', 'analyst')
    .set('X-SmartPerfetto-SSO-Scopes', 'trace:read,trace:write')
    .set('X-Window-Id', 'window-a');
}

function adminHeaders(req: request.Test, workspaceId = 'workspace-a'): request.Test {
  return req
    .set('X-SmartPerfetto-SSO-User-Id', 'admin-a')
    .set('X-SmartPerfetto-SSO-Email', 'admin-a@example.test')
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', workspaceId)
    .set('X-SmartPerfetto-SSO-Roles', 'workspace_admin')
    .set('X-SmartPerfetto-SSO-Scopes', 'trace:read,trace:write,runtime:manage')
    .set('X-Window-Id', 'admin-window');
}

function binaryParser(res: request.Response, callback: (err: Error | null, body: Buffer) => void): void {
  const chunks: Buffer[] = [];
  res.on('data', chunk => chunks.push(Buffer.from(chunk)));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind to a TCP port');
  return address.port;
}

async function closeServer(server?: Server): Promise<void> {
  if (!server || !server.listening) return;
  server.closeAllConnections?.();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function seedEnterpriseGraph(): void {
  const db = openEnterpriseDb(dbPath);
  try {
    const now = Date.now();
    db.prepare(`
      INSERT INTO organizations (id, name, status, plan, created_at, updated_at)
      VALUES ('tenant-a', 'Tenant A', 'active', 'enterprise', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO workspaces (id, tenant_id, name, created_at, updated_at)
      VALUES ('workspace-a', 'tenant-a', 'Workspace A', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
      VALUES ('user-a', 'tenant-a', 'user-a@example.test', 'User A', 'user-a', ?, ?)
    `).run(now, now);
    db.prepare(`
      INSERT INTO memberships (tenant_id, workspace_id, user_id, role, created_at)
      VALUES ('tenant-a', 'workspace-a', 'user-a', 'analyst', ?)
    `).run(now);
    db.prepare(`
      INSERT INTO trace_assets
        (id, tenant_id, workspace_id, owner_user_id, local_path, status, created_at)
      VALUES
        ('trace-a', 'tenant-a', 'workspace-a', 'user-a', ?, 'ready', ?)
    `).run(path.join(tmpDir, 'trace-a.trace'), now);
  } finally {
    db.close();
  }
}

function createReadyLease(): TraceProcessorLeaseRecord {
  const store = getTraceProcessorLeaseStore();
  let next = store.acquireHolder(scope, 'trace-a', {
    holderType: 'frontend_http_rpc',
    holderRef: 'window-a',
    windowId: 'window-a',
  });
  next = store.markStarting(scope, next.id);
  return store.markReady(scope, next.id);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartperfetto-tp-proxy-'));
  dbPath = path.join(tmpDir, 'enterprise.sqlite');
  process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'true';
  process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'true';
  process.env[ENTERPRISE_DB_PATH_ENV] = dbPath;
  delete process.env.SMARTPERFETTO_API_KEY;
  process.env[TRACE_PROCESSOR_CAPABILITY_SECRET_ENV] =
    'test-trace-processor-capability-secret-at-least-32-bytes';
  resetTraceProcessorProxyCapabilitiesForTests();

  upstreamServer = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(Buffer.from(chunk)));
    req.on('end', () => {
      if (req.url === '/status') {
        res.writeHead(200, {'content-type': 'application/x-protobuf'});
        res.end(Buffer.from([1, 2, 3]));
        return;
      }
      if (req.url === '/query') {
        res.writeHead(200, {'content-type': 'application/x-protobuf'});
        res.end(Buffer.concat(chunks));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  upstreamServer.on('upgrade', (req, socket) => {
    expect(req.url).toBe('/websocket');
    expect(req.headers.origin).toBe('http://127.0.0.1:10000');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + '\r\n',
    );
    socket.on('data', chunk => socket.write(chunk));
  });
  upstreamSockets = new Set();
  upstreamServer.on('connection', socket => {
    upstreamSockets.add(socket);
    socket.on('close', () => upstreamSockets.delete(socket));
  });
  upstreamPort = await listen(upstreamServer);

  seedEnterpriseGraph();
  lease = createReadyLease();
  queryRawMock = jest.fn(async (_traceId: string, body: Buffer) => body);
  restartLeaseMock = jest.fn(async (traceId, leaseId, _mode, restartScope) => {
    const store = getTraceProcessorLeaseStore();
    store.markCrashed(restartScope, leaseId);
    store.markRestarting(restartScope, leaseId);
    store.markReady(restartScope, leaseId);
    return { id: 'restarted-processor', traceId };
  });
  setTraceProcessorServiceForTests({
    getOrLoadTrace: jest.fn(async () => ({
      id: 'trace-a',
      filename: 'trace-a.perfetto',
      size: 16,
      uploadTime: new Date(),
      status: 'ready',
    })),
    ensureProcessorForLease: jest.fn(async () => undefined),
    getTraceWithLeasePort: jest.fn(() => ({
      id: 'trace-a',
      filename: 'trace-a.perfetto',
      size: 16,
      uploadTime: new Date(),
      status: 'ready',
      port: upstreamPort,
      processor: {status: 'ready'},
    })),
    getTraceWithPort: jest.fn(() => ({
      id: 'trace-a',
      filename: 'trace-a.perfetto',
      size: 16,
      uploadTime: new Date(),
      status: 'ready',
      port: upstreamPort,
      processor: {status: 'ready'},
    })),
    queryRaw: queryRawMock,
    restartLease: restartLeaseMock,
  } as any);
});

afterEach(async () => {
  jest.restoreAllMocks();
  for (const socket of upstreamSockets ?? []) {
    socket.destroy();
  }
  await closeServer(upstreamServer);
  setTraceProcessorServiceForTests(null);
  setTraceProcessorLeaseStoreForTests(null);
  restoreEnvValue(ENTERPRISE_FEATURE_FLAG_ENV, originalEnv.enterprise);
  restoreEnvValue('SMARTPERFETTO_SSO_TRUSTED_HEADERS', originalEnv.trustedHeaders);
  restoreEnvValue(ENTERPRISE_DB_PATH_ENV, originalEnv.enterpriseDbPath);
  restoreEnvValue('SMARTPERFETTO_API_KEY', originalEnv.apiKey);
  restoreEnvValue(
    TRACE_PROCESSOR_CAPABILITY_SECRET_ENV,
    originalEnv.capabilitySecret,
  );
  resetTraceProcessorProxyCapabilitiesForTests();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('trace processor lease proxy routes', () => {
  it('rejects unauthenticated websocket upgrades when a legacy API key is configured', async () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'false';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'false';
    process.env.SMARTPERFETTO_API_KEY = 'configured-legacy-key';
    const app = makeApp();
    const proxyServer = http.createServer(app);
    proxyServer.on('upgrade', (req, socket, head) => {
      if (handleTraceProcessorProxyUpgrade(req, socket, head)) return;
      socket.destroy();
    });
    const proxyPort = await listen(proxyServer);

    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request({
          host: '127.0.0.1',
          port: proxyPort,
          path: `/api/tp/${lease.id}/websocket?tenantId=tenant-a&workspaceId=workspace-a`,
          headers: {
            Upgrade: 'websocket',
            Connection: 'Upgrade',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version': '13',
          },
        });
        req.on('response', response => resolve(response.statusCode ?? 0));
        req.on('upgrade', (_response, socket) => {
          socket.destroy();
          reject(new Error('unauthenticated websocket unexpectedly upgraded'));
        });
        req.on('error', reject);
        req.end();
      });
      expect(status).toBe(401);
    } finally {
      await closeServer(proxyServer);
    }
  });

  it('proxies status and query bytes through the scoped lease', async () => {
    const app = makeApp();

    const statusRes = await ssoHeaders(
      request(app)
        .post(`/api/tp/${lease.id}/status`)
        .buffer(true)
        .parse(binaryParser),
    );
    expect(statusRes.status).toBe(200);
    expect(Buffer.from(statusRes.body)).toEqual(Buffer.from([1, 2, 3]));

    const queryBody = Buffer.from([9, 8, 7]);
    const queryRes = await ssoHeaders(
      request(app)
        .post(`/api/tp/${lease.id}/query`)
        .set('Content-Type', 'application/x-protobuf')
        .send(queryBody)
        .buffer(true)
        .parse(binaryParser),
    );
    expect(queryRes.status).toBe(200);
    expect(Buffer.from(queryRes.body)).toEqual(queryBody);
    expect(queryRawMock).toHaveBeenCalledWith(
      'trace-a',
      queryBody,
      expect.objectContaining({
        priority: 'p0',
        leaseId: lease.id,
        leaseMode: 'shared',
        leaseScope: {
          tenantId: 'tenant-a',
          workspaceId: 'workspace-a',
          userId: 'user-a',
        },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('preserves scoped lease routing for concurrent proxy queries', async () => {
    const app = makeApp();
    queryRawMock.mockImplementation(async (_traceId: string, body: Buffer) => {
      if (body.equals(Buffer.from([1, 2, 3]))) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      return Buffer.from(body);
    });

    const [firstQuery, secondQuery] = await Promise.all([
      ssoHeaders(
        request(app)
          .post(`/api/tp/${lease.id}/query`)
          .set('Content-Type', 'application/x-protobuf')
          .send(Buffer.from([1, 2, 3]))
          .buffer(true)
          .parse(binaryParser),
      ),
      ssoHeaders(
        request(app)
          .post(`/api/tp/${lease.id}/query`)
          .set('Content-Type', 'application/x-protobuf')
          .send(Buffer.from([4, 5, 6]))
          .buffer(true)
          .parse(binaryParser),
      ),
    ]);

    expect(firstQuery.status).toBe(200);
    expect(Buffer.from(firstQuery.body)).toEqual(Buffer.from([1, 2, 3]));
    expect(secondQuery.status).toBe(200);
    expect(Buffer.from(secondQuery.body)).toEqual(Buffer.from([4, 5, 6]));
    expect(queryRawMock).toHaveBeenCalledTimes(2);
    for (const call of queryRawMock.mock.calls) {
      expect(call[0]).toBe('trace-a');
      expect(call[2]).toEqual(expect.objectContaining({
        priority: 'p0',
        leaseId: lease.id,
        leaseMode: 'shared',
        leaseScope: {
          tenantId: 'tenant-a',
          workspaceId: 'workspace-a',
          userId: 'user-a',
        },
        signal: expect.any(AbortSignal),
      }));
    }
  });

  it('hides leases from other workspaces', async () => {
    const app = makeApp();

    const res = await ssoHeaders(
      request(app).post(`/api/tp/${lease.id}/status`),
      'workspace-b',
    );

    expect(res.status).toBe(404);
  });

  it('refreshes frontend holder heartbeat with hidden visibility TTL', async () => {
    const app = makeApp();
    const before = Date.now();

    const res = await ssoHeaders(
      request(app)
        .post(`/api/tp/${lease.id}/heartbeat`)
        .send({ visibility: 'hidden' }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      action: 'heartbeat',
      lease: {
        id: lease.id,
        state: 'active',
      },
      holder: {
        holderType: 'frontend_http_rpc',
        holderRef: 'window-a',
        windowId: 'window-a',
        frontendVisibility: 'hidden',
      },
    });
    const updated = getTraceProcessorLeaseStore().getLeaseById(scope, lease.id);
    const holder = updated?.holders.find(item => item.holderRef === 'window-a');
    expect(holder).toBeDefined();
    expect(holder?.metadata).toEqual(expect.objectContaining({
      frontendVisibility: 'hidden',
      heartbeat: 'frontend',
      proxy: 'trace_processor',
    }));
    expect(holder?.expiresAt ?? 0).toBeGreaterThanOrEqual(before + 10 * 60 * 1000 - 1000);
  });

  it('reacquires the frontend holder on heartbeat after the window holder disappeared', async () => {
    const app = makeApp();
    const store = getTraceProcessorLeaseStore();
    store.releaseHolder(scope, lease.id, 'frontend_http_rpc', 'window-a');
    expect(store.getLeaseById(scope, lease.id)?.holderCount).toBe(0);
    const before = Date.now();

    const res = await ssoHeaders(
      request(app)
        .post(`/api/tp/${lease.id}/heartbeat`)
        .send({ visibility: 'offline' }),
    );

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      success: true,
      action: 'heartbeat',
      lease: {
        id: lease.id,
        state: 'active',
        holderCount: 1,
      },
      holder: {
        holderType: 'frontend_http_rpc',
        holderRef: 'window-a',
        frontendVisibility: 'offline',
      },
    });
    const reacquired = store.getLeaseById(scope, lease.id);
    const holder = reacquired?.holders.find(item => item.holderRef === 'window-a');
    expect(holder).toBeDefined();
    expect(holder?.metadata).toEqual(expect.objectContaining({
      frontendVisibility: 'offline',
      heartbeat: 'frontend',
    }));
    expect(holder?.expiresAt ?? 0).toBeGreaterThanOrEqual(before + 30 * 60 * 1000 - 1000);
  });

  it('rejects invalid frontend heartbeat visibility', async () => {
    const app = makeApp();

    const res = await ssoHeaders(
      request(app)
        .post(`/api/tp/${lease.id}/heartbeat`)
        .send({ visibility: 'minimized' }),
    );

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: 'frontend visibility must be visible, hidden, or offline',
    });
  });

  it('requires runtime manage permission for lease admin actions', async () => {
    const app = makeApp();

    const res = await ssoHeaders(
      request(app)
        .post(`/api/tp/${lease.id}/restart`)
        .send({ reason: 'hung query' }),
    );

    expect(res.status).toBe(403);
    expect(restartLeaseMock).not.toHaveBeenCalled();
  });

  it('lets workspace admins drain a scoped lease and block new proxy work', async () => {
    const app = makeApp();

    const drainRes = await adminHeaders(
      request(app)
        .post(`/api/tp/${lease.id}/drain`)
        .send({ reason: 'hung query' }),
    );

    expect(drainRes.status).toBe(200);
    expect(drainRes.body).toMatchObject({
      success: true,
      action: 'drain',
      reason: 'hung query',
      lease: {
        id: lease.id,
        state: 'draining',
      },
    });

    const blockedRes = await adminHeaders(
      request(app).post(`/api/tp/${lease.id}/status`),
    );
    expect(blockedRes.status).toBe(409);
    expect(blockedRes.body.error).toBe('Trace processor lease is draining');
  });

  it('lets workspace admins restart a scoped lease without changing the lease id', async () => {
    const app = makeApp();

    const restartRes = await adminHeaders(
      request(app)
        .post(`/api/tp/${lease.id}/restart`)
        .send({ reason: 'operator restart after hung query' }),
    );

    expect(restartRes.status).toBe(200);
    expect(restartRes.body).toMatchObject({
      success: true,
      action: 'restart',
      reason: 'operator restart after hung query',
      lease: {
        id: lease.id,
        traceId: 'trace-a',
        state: 'active',
      },
    });
    expect(restartLeaseMock).toHaveBeenCalledWith(
      'trace-a',
      lease.id,
      'shared',
      {
        tenantId: 'tenant-a',
        workspaceId: 'workspace-a',
        userId: 'admin-a',
      },
    );
  });

  it('tunnels API-key browser websocket upgrades with a scoped capability', async () => {
    const app = makeApp();
    const proxyServer = http.createServer(app);
    const proxySockets = new Set<NetSocket>();
    proxyServer.on('connection', socket => {
      proxySockets.add(socket);
      socket.on('close', () => proxySockets.delete(socket));
    });
    proxyServer.on('upgrade', (req, socket, head) => {
      if (handleTraceProcessorProxyUpgrade(req, socket, head)) return;
      socket.destroy();
    });
    const proxyPort = await listen(proxyServer);

    try {
      process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'false';
      const capability = issueTraceProcessorProxyCapability({
        context: {
          tenantId: 'tenant-a',
          workspaceId: 'workspace-a',
          userId: 'user-a',
          authType: 'api_key',
          roles: ['api_key'],
          scopes: ['trace:read'],
          requestId: 'upload-request',
          windowId: 'window-a',
        },
        leaseId: lease.id,
      });
      const echoed = await new Promise<string>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('websocket tunnel timed out'));
        }, 5000);
        const finish = (value: string): void => {
          clearTimeout(timeout);
          resolve(value);
        };
        const fail = (error: Error): void => {
          clearTimeout(timeout);
          reject(error);
        };
        const req = http.request({
          host: '127.0.0.1',
          port: proxyPort,
          path: `/api/tp/${lease.id}/websocket`,
          headers: {
            Upgrade: 'websocket',
            Connection: 'Upgrade',
            'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
            'Sec-WebSocket-Version': '13',
            'Sec-WebSocket-Protocol': capability.protocol,
            Origin: 'http://127.0.0.1:54321',
          },
        });
        req.setTimeout(5000, () => {
          req.destroy(new Error('websocket tunnel timed out'));
        });
        req.on('response', res => {
          fail(new Error(`expected upgrade, got HTTP ${res.statusCode}`));
        });
        req.on('upgrade', (res, socket, head) => {
          let buffer = `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n`;
          expect(res.headers['sec-websocket-protocol']).toBe(capability.protocol);
          if (head.length > 0) buffer += head.toString('utf8');
          socket.setTimeout(5000, () => {
            socket.destroy(new Error('websocket echo timed out'));
          });
          socket.on('error', fail);
          socket.on('data', chunk => {
            buffer += chunk.toString('utf8');
            if (buffer.includes('ping-through-proxy')) {
              socket.destroy();
              finish(buffer);
            }
          });
          socket.write('ping-through-proxy');
        });
        req.on('error', fail);
        req.end();
      });

      expect(echoed).toContain('101 Switching Protocols');
      expect(echoed).toContain('ping-through-proxy');
    } finally {
      for (const socket of proxySockets) {
        socket.destroy();
      }
      await closeServer(proxyServer);
    }
  });
});
