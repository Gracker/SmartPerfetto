// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import fs from 'fs/promises';
import http, { type Server } from 'http';
import net, { type Socket as NetSocket } from 'net';
import os from 'os';
import path from 'path';
import request from 'supertest';
import { ENTERPRISE_FEATURE_FLAG_ENV } from '../../config';
import { ENTERPRISE_DB_PATH_ENV, openEnterpriseDb } from '../../services/enterpriseDb';
import { EnterpriseApiKeyService } from '../../services/enterpriseApiKeyService';
import { EnterpriseSsoService } from '../../services/enterpriseSsoService';
import type { EnterpriseRepositoryScope } from '../../services/enterpriseRepository';
import {
  frontendHolderRef,
  getTraceProcessorLeaseStore,
  setTraceProcessorLeaseStoreForTests,
  type TraceProcessorLeaseRecord,
} from '../../services/traceProcessorLeaseStore';
import { setTraceProcessorServiceForTests } from '../../services/traceProcessorService';
import { normalizeCorsOrigins } from '../../security/requestOriginPolicy';
import {
  TRACE_PROCESSOR_CAPABILITY_SECRET_ENV,
  issueTraceProcessorProxyCapability,
  resetTraceProcessorProxyCapabilitiesForTests,
} from '../../services/traceProcessorProxyCapability';
import traceProcessorProxyRoutes, {
  REJECTED_UPGRADE_LINGER_MS,
} from '../traceProcessorProxyRoutes';
import { dispatchUpgrade } from '../../middleware/httpEdge';

const originalEnv = {
  enterprise: process.env[ENTERPRISE_FEATURE_FLAG_ENV],
  trustedHeaders: process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS,
  enterpriseDbPath: process.env[ENTERPRISE_DB_PATH_ENV],
  apiKey: process.env.SMARTPERFETTO_API_KEY,
  capabilitySecret: process.env[TRACE_PROCESSOR_CAPABILITY_SECRET_ENV],
};
const oidcEnv: Record<string, string> = {
  SMARTPERFETTO_OIDC_ISSUER_URL: 'https://idp.example.test',
  SMARTPERFETTO_OIDC_CLIENT_ID: 'client-a',
  SMARTPERFETTO_OIDC_CLIENT_SECRET: 'client-secret-a',
  SMARTPERFETTO_OIDC_REDIRECT_URI: 'https://app.example.test/api/auth/oidc/callback',
  SMARTPERFETTO_SERVER_SECRET: 'test-server-secret-at-least-32-bytes',
  FRONTEND_URL: 'https://app.example.test',
};
const originalOidcEnv = Object.fromEntries(Object.keys(oidcEnv).map(key => [key, process.env[key]]));

const scope: EnterpriseRepositoryScope = {
  tenantId: 'tenant-a',
  workspaceId: 'workspace-a',
  userId: 'user-a',
};
const WINDOW_A_HOLDER = frontendHolderRef({userId: 'user-a', windowId: 'window-a'});
/** The origins CORS admits in these tests: FRONTEND_URL and the local loopback UI. */
const ALLOWED_ORIGINS = normalizeCorsOrigins([oidcEnv.FRONTEND_URL, 'http://127.0.0.1:10000']);

let tmpDir: string;
let dbPath: string;
let upstreamServer: Server;
let upstreamSockets: Set<NetSocket>;
let upstreamPort: number;
let lease: TraceProcessorLeaseRecord;
let queryRawMock: jest.MockedFunction<(traceId: string, body: Buffer, options?: any) => Promise<Buffer>>;
let exposeNativePortMock: jest.Mock;
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
  return userSsoHeaders(req, {workspaceId});
}

function userSsoHeaders(
  req: request.Test,
  options: {userId?: string; workspaceId?: string; windowId?: string | null; correlationId?: string} = {},
): request.Test {
  const userId = options.userId ?? 'user-a';
  const windowId = options.windowId === undefined ? 'window-a' : options.windowId;
  let next = req
    .set('X-SmartPerfetto-SSO-User-Id', userId)
    .set('X-SmartPerfetto-SSO-Email', `${userId}@example.test`)
    .set('X-SmartPerfetto-SSO-Tenant-Id', 'tenant-a')
    .set('X-SmartPerfetto-SSO-Workspace-Id', options.workspaceId ?? 'workspace-a')
    .set('X-SmartPerfetto-SSO-Roles', 'analyst')
    .set('X-SmartPerfetto-SSO-Scopes', 'trace:read,trace:write');
  if (windowId) next = next.set('X-Window-Id', windowId);
  if (options.correlationId) next = next.set('X-Correlation-Id', options.correlationId);
  return next;
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

/** Attempt a WebSocket upgrade; resolves 101 when the proxy tunnelled it, else the HTTP status. */
async function upgradeStatus(
  proxyPort: number,
  urlPath: string,
  headers: Record<string, string> = {},
): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port: proxyPort, path: urlPath, headers: {
      Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'Sec-WebSocket-Version': '13', ...headers,
    }});
    req.setTimeout(5000, () => req.destroy(new Error('websocket upgrade timed out')));
    req.on('response', res => {res.resume(); resolve(res.statusCode ?? 0);});
    req.on('upgrade', (res, socket) => {socket.destroy(); resolve(res.statusCode ?? 0);});
    req.on('error', reject);
    req.end();
  });
}

async function withUpgradeProxy(run: (proxyPort: number, proxyServer: Server) => Promise<void>): Promise<void> {
  const proxyServer = http.createServer(makeApp());
  // Upgraded sockets leave the server's connection tracking, so close them here.
  const proxySockets = new Set<NetSocket>();
  proxyServer.on('connection', socket => {
    proxySockets.add(socket);
    socket.on('close', () => proxySockets.delete(socket));
  });
  // The production upgrade listener.
  proxyServer.on('upgrade', (req, socket, head) => dispatchUpgrade(req, socket, head, ALLOWED_ORIGINS));
  const proxyPort = await listen(proxyServer);
  try {
    await run(proxyPort, proxyServer);
  } finally {
    for (const socket of proxySockets) socket.destroy();
    await closeServer(proxyServer);
  }
}

/**
 * Opens a raw SSO-authenticated upgrade from a peer that never closes its
 * side, so only the proxy can end the connection. Returns the proxy's
 * accepted socket and what the peer has received so far.
 */
async function openRawUpgrade(proxyServer: Server, proxyPort: number): Promise<{
  proxySocket: NetSocket;
  received: () => string;
}> {
  const accepted = new Promise<NetSocket>(resolve => proxyServer.once('connection', resolve));
  const client = net.connect({host: '127.0.0.1', port: proxyPort, allowHalfOpen: true});
  client.on('error', () => {});
  let received = '';
  client.on('data', chunk => {received += chunk.toString('utf8');});
  const proxySocket = await accepted;
  proxySocket.once('close', () => client.destroy());
  client.write([
    `GET /api/tp/${lease.id}/websocket?workspaceId=workspace-a HTTP/1.1`,
    `Host: 127.0.0.1:${proxyPort}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version: 13',
    'X-SmartPerfetto-SSO-User-Id: user-a',
    'X-SmartPerfetto-SSO-Tenant-Id: tenant-a',
    '', '',
  ].join('\r\n'));
  return {proxySocket, received: () => received};
}

async function closedWithin(socket: NetSocket, ms: number): Promise<boolean> {
  if (socket.destroyed) return true;
  return new Promise<boolean>(resolve => {
    const timer = setTimeout(() => resolve(false), ms);
    socket.once('close', () => {clearTimeout(timer); resolve(true);});
  });
}

async function waitFor(condition: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

/** A raw TCP upstream that does `onRequest` to its socket once the proxied request arrives. */
async function rawUpstream(onRequest: (socket: NetSocket) => void): Promise<net.Server> {
  const server = net.createServer(socket => {
    socket.on('error', () => {});
    socket.once('data', () => onRequest(socket));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

function frontendHolder(windowId: string) {
  return getTraceProcessorLeaseStore().getLeaseById(scope, lease.id)
    ?.holders.find(holder => holder.holderType === 'frontend_http_rpc' && holder.windowId === windowId);
}

let apiKeyDb: ReturnType<typeof openEnterpriseDb> | undefined;

function useEnterpriseApiKeyService(): EnterpriseApiKeyService {
  apiKeyDb = openEnterpriseDb(dbPath);
  const service = new EnterpriseApiKeyService(apiKeyDb);
  EnterpriseApiKeyService.setInstanceForTests(service);
  return service;
}

function createEnterpriseApiKey(service: EnterpriseApiKeyService, options: {workspaceId?: null} = {}): string {
  return service.createApiKey({
    tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a', authType: 'sso',
    roles: ['org_admin'], scopes: ['*'], requestId: 'seed-api-key',
  }, options).token;
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
    holderRef: WINDOW_A_HOLDER,
    windowId: 'window-a',
    metadata: {userId: 'user-a'},
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
    expect(exposeNativePortMock).toHaveBeenCalledWith(upstreamPort);
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
  exposeNativePortMock = jest.fn();
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
    isPrivateAnalysisProcessorKey: jest.fn(() => false),
    exposeNativePort: exposeNativePortMock,
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
  for (const [key, value] of Object.entries(originalOidcEnv)) restoreEnvValue(key, value);
  EnterpriseApiKeyService.resetForTests();
  EnterpriseSsoService.resetForTests();
  apiKeyDb?.close();
  apiKeyDb = undefined;
  resetTraceProcessorProxyCapabilitiesForTests();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('trace processor lease proxy routes', () => {
  it.each(['status', 'query', 'heartbeat'])('rejects private analysis %s before acquiring a frontend holder or forwarding', async endpoint => {
    const store = getTraceProcessorLeaseStore();
    let privateLease = store.acquireHolder(scope, 'trace-a', {holderType: 'agent_run', holderRef: 'private-run',
      metadata: {analysisRunPrivate: true}}, {mode: 'isolated'});
    store.markStarting(scope, privateLease.id);
    privateLease = store.markReady(scope, privateLease.id);
    const before = store.getLeaseById(scope, privateLease.id);
    const response = await ssoHeaders(request(makeApp()).post(`/api/tp/${privateLease.id}/${endpoint}`).send({visibility: 'visible'}));
    expect(response.status).toBe(403);
    expect(response.body.details).toContain('Private analysis processor');
    expect(store.getLeaseById(scope, privateLease.id)).toEqual(before);
    expect(queryRawMock).not.toHaveBeenCalled();
    expect(exposeNativePortMock).not.toHaveBeenCalled();
    expect(upstreamSockets.size).toBe(0);
  });

  it('rejects a private analysis WebSocket capability before opening an upstream connection', async () => {
    const store = getTraceProcessorLeaseStore();
    const privateLease = store.acquireHolder(scope, 'trace-a', {holderType: 'agent_run', holderRef: 'private-websocket',
      metadata: {analysisRunPrivate: true}}, {mode: 'isolated'});
    store.markStarting(scope, privateLease.id); store.markReady(scope, privateLease.id);
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'false';
    const capability = issueTraceProcessorProxyCapability({context: {
      tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a', authType: 'api_key',
      roles: ['api_key'], scopes: ['trace:read'], requestId: 'private-upgrade', windowId: 'window-a',
    }, leaseId: privateLease.id});
    await withUpgradeProxy(async proxyPort => {
      expect(await upgradeStatus(proxyPort, `/api/tp/${privateLease.id}/websocket`, {
        'Sec-WebSocket-Protocol': capability.protocol,
      })).toBe(403);
    });
    expect(store.getLeaseById(scope, privateLease.id)?.holders.map(holder => holder.holderType)).toEqual(['agent_run']);
    expect(exposeNativePortMock).not.toHaveBeenCalled();
    expect(upstreamSockets.size).toBe(0);
  });

  it('rejects unauthenticated websocket upgrades when a legacy API key is configured', async () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'false';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'false';
    process.env.SMARTPERFETTO_API_KEY = 'configured-legacy-key';
    await withUpgradeProxy(async proxyPort => {
      expect(await upgradeStatus(proxyPort,
        `/api/tp/${lease.id}/websocket?tenantId=tenant-a&workspaceId=workspace-a`)).toBe(401);
    });
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
        holderRef: WINDOW_A_HOLDER,
        windowId: 'window-a',
        frontendVisibility: 'hidden',
      },
    });
    const updated = getTraceProcessorLeaseStore().getLeaseById(scope, lease.id);
    const holder = updated?.holders.find(item => item.holderRef === WINDOW_A_HOLDER);
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
    store.releaseHolder(scope, lease.id, 'frontend_http_rpc', WINDOW_A_HOLDER);
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
        holderRef: WINDOW_A_HOLDER,
        frontendVisibility: 'offline',
      },
    });
    const reacquired = store.getLeaseById(scope, lease.id);
    const holder = reacquired?.holders.find(item => item.holderRef === WINDOW_A_HOLDER);
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

  describe('frontend holder identity', () => {
    function frontendHolders() {
      return (getTraceProcessorLeaseStore().getLeaseById(scope, lease.id)?.holders ?? [])
        .filter(holder => holder.holderType === 'frontend_http_rpc');
    }

    function frontendHolderRefs(): string[] {
      return frontendHolders().map(holder => holder.holderRef).sort();
    }

    it('keeps one holder for a client without a window id across requests', async () => {
      const app = makeApp();
      const client = {windowId: null};

      expect((await userSsoHeaders(request(app).post(`/api/tp/${lease.id}/status`), client)).status).toBe(200);
      expect((await userSsoHeaders(
        request(app)
          .post(`/api/tp/${lease.id}/query`)
          .set('Content-Type', 'application/x-protobuf')
          .send(Buffer.from([1])),
        client,
      )).status).toBe(200);
      const heartbeat = await userSsoHeaders(
        request(app).post(`/api/tp/${lease.id}/heartbeat`).send({visibility: 'visible'}),
        client,
      );
      expect(heartbeat.status).toBe(200);

      const windowlessHolder = frontendHolderRef({userId: 'user-a'});
      expect(heartbeat.body.holder).toMatchObject({holderRef: windowlessHolder, windowId: null});
      expect(frontendHolderRefs()).toEqual([WINDOW_A_HOLDER, windowlessHolder].sort());
    });

    it('does not merge windows that reuse one correlation id', async () => {
      const app = makeApp();

      for (const windowId of ['window-a', 'window-b']) {
        const res = await userSsoHeaders(
          request(app).post(`/api/tp/${lease.id}/heartbeat`).send({visibility: 'visible'}),
          {windowId, correlationId: 'shared-correlation'},
        );
        expect(res.status).toBe(200);
      }

      const windowBHolder = frontendHolderRef({userId: 'user-a', windowId: 'window-b'});
      expect(frontendHolderRefs()).toEqual([WINDOW_A_HOLDER, windowBHolder].sort());
    });

    it('keeps another user with the same window id off the existing holder', async () => {
      const app = makeApp();

      const res = await userSsoHeaders(
        request(app).post(`/api/tp/${lease.id}/heartbeat`).send({visibility: 'visible'}),
        {userId: 'user-b', windowId: 'window-a'},
      );
      expect(res.status).toBe(200);

      const userBHolder = frontendHolderRef({userId: 'user-b', windowId: 'window-a'});
      expect(frontendHolderRefs()).toEqual([WINDOW_A_HOLDER, userBHolder].sort());
      const holders = frontendHolders();
      expect(holders.find(holder => holder.holderRef === WINDOW_A_HOLDER)?.metadata?.userId).toBe('user-a');
      expect(holders.find(holder => holder.holderRef === userBHolder)?.metadata?.userId).toBe('user-b');
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
    await withUpgradeProxy(async proxyPort => {
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
            'X-Correlation-Id': 'ws correlation:1',
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
      // The upgrade has no Express request, yet resolves the same request id.
      const holder = getTraceProcessorLeaseStore().getLeaseById(scope, lease.id)
        ?.holders.find(item => item.holderRef === WINDOW_A_HOLDER);
      expect(holder?.metadata).toEqual(expect.objectContaining({requestId: 'wscorrelation:1'}));
    });
  });
  // The upgrade resolves identity through the same function as HTTP auth; the
  // query string only adds scope a browser cannot send as a header.
  it('resolves a trusted SSO upgrade with the HTTP defaults and query scope', async () => {
    await withUpgradeProxy(async proxyPort => {
      const status = await upgradeStatus(proxyPort, `/api/tp/${lease.id}/websocket?workspaceId=workspace-a&windowId=window-q`, {
        'X-SmartPerfetto-SSO-User-Id': 'user-a',
        'X-SmartPerfetto-SSO-Tenant-Id': 'tenant-a',
      });
      expect(status).toBe(101);
      expect(frontendHolder('window-q')).toMatchObject({
        holderRef: frontendHolderRef({userId: 'user-a', windowId: 'window-q'}),
        metadata: expect.objectContaining({userId: 'user-a'}),
      });
    });
  });

  it('resolves a local dev upgrade from the query string', async () => {
    process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'false';
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'false';
    await withUpgradeProxy(async proxyPort => {
      const status = await upgradeStatus(proxyPort,
        `/api/tp/${lease.id}/websocket?tenantId=tenant-a&workspaceId=workspace-a&windowId=window-dev&userId=user-a`);
      expect(status).toBe(101);
      expect(frontendHolder('window-dev')).toMatchObject({
        holderRef: frontendHolderRef({userId: 'user-a', windowId: 'window-dev'}),
        metadata: expect.objectContaining({userId: 'user-a'}),
      });
    });
  });

  it('never trusts SSO identity headers on an upgrade under built-in OIDC', async () => {
    Object.assign(process.env, oidcEnv);
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'yes';
    await withUpgradeProxy(async proxyPort => {
      const status = await upgradeStatus(proxyPort, `/api/tp/${lease.id}/websocket`, {
        'X-SmartPerfetto-SSO-User-Id': 'user-a',
        'X-SmartPerfetto-SSO-Tenant-Id': 'tenant-a',
        'X-SmartPerfetto-SSO-Workspace-Id': 'workspace-a',
        'X-Window-Id': 'forged-window',
      });
      expect(status).not.toBe(101);
      expect(frontendHolder('forged-window')).toBeUndefined();
      expect(exposeNativePortMock).not.toHaveBeenCalled();
    });
  });

  it('accepts no enterprise API key on an upgrade under built-in OIDC', async () => {
    Object.assign(process.env, oidcEnv);
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'false';
    const token = createEnterpriseApiKey(useEnterpriseApiKeyService());
    await withUpgradeProxy(async proxyPort => {
      expect(await upgradeStatus(proxyPort, `/api/tp/${lease.id}/websocket`, {
        Authorization: `Bearer ${token}`,
      })).toBe(401);
      expect(exposeNativePortMock).not.toHaveBeenCalled();
    });
  });

  it('keeps an unbound enterprise API key in the default workspace on an upgrade', async () => {
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'false';
    const service = useEnterpriseApiKeyService();
    const boundToken = createEnterpriseApiKey(service);
    const unboundToken = createEnterpriseApiKey(service, {workspaceId: null});
    await withUpgradeProxy(async proxyPort => {
      // A page cannot attach an API key ambiently, so its Origin is not checked.
      expect(await upgradeStatus(proxyPort, `/api/tp/${lease.id}/websocket`, {
        Authorization: `Bearer ${boundToken}`, Origin: 'https://evil.example.test',
      })).toBe(101);
      // As over HTTP, neither the query nor a header selects its workspace.
      expect(await upgradeStatus(proxyPort, `/api/tp/${lease.id}/websocket?workspaceId=workspace-a`, {
        Authorization: `Bearer ${unboundToken}`,
        'X-Workspace-Id': 'workspace-a',
      })).toBe(404);
    });
  });

  it('rejects an unusable enterprise API key instead of falling back to a capability', async () => {
    process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'false';
    useEnterpriseApiKeyService();
    const capability = issueTraceProcessorProxyCapability({context: {
      tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a', authType: 'api_key',
      roles: ['api_key'], scopes: ['trace:read'], requestId: 'capability-request', windowId: 'window-cap',
    }, leaseId: lease.id});
    await withUpgradeProxy(async proxyPort => {
      expect(await upgradeStatus(proxyPort, `/api/tp/${lease.id}/websocket`, {
        Authorization: 'Bearer spak_revoked-or-unknown',
        'Sec-WebSocket-Protocol': capability.protocol,
      })).toBe(401);
      expect(frontendHolder('window-cap')).toBeUndefined();
    });
  });
  // A browser attaches a session cookie, a trusted proxy's session or, in
  // keyless local mode, nothing at all to any page's WebSocket, and no CORS
  // check runs on an upgrade. The Origin decides before any lease work.
  it('answers a malformed lease id escape with 400 instead of throwing', async () => {
    await withUpgradeProxy(async proxyPort => {
      expect(await upgradeStatus(proxyPort, '/api/tp/%E0/websocket')).toBe(400);
      // The server still serves upgrades afterwards.
      expect(await upgradeStatus(proxyPort, `/api/tp/${lease.id}/websocket?workspaceId=workspace-a`, {
        'X-SmartPerfetto-SSO-User-Id': 'user-a', 'X-SmartPerfetto-SSO-Tenant-Id': 'tenant-a',
      })).toBe(101);
    });
  });

  describe('upstream failures', () => {
    let rawServer: net.Server | undefined;

    afterEach(async () => {
      if (rawServer?.listening) await new Promise<void>(resolve => rawServer!.close(() => resolve()));
      rawServer = undefined;
    });

    it('delivers a 502 when the upstream refuses, and leaves the socket to the rejection', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      // A refusal without a real port: a closed port can be taken by another
      // process before the proxy connects. The proxy's connection to this
      // sentinel port fails like ECONNREFUSED (error, then close, never
      // connect); every other connection, the test client's included, is real.
      const refusedPort = 1;
      const connect = net.connect.bind(net) as (...args: unknown[]) => NetSocket;
      const connectSpy = jest.spyOn(net, 'connect').mockImplementation(((...args: unknown[]) => {
        const options = args[0] as {port?: number} | undefined;
        if (options?.port !== refusedPort) return connect(...args);
        const refused = new net.Socket();
        process.nextTick(() => refused.destroy(Object.assign(
          new Error(`connect ECONNREFUSED 127.0.0.1:${refusedPort}`), {code: 'ECONNREFUSED'})));
        return refused;
      }) as typeof net.connect);
      upstreamPort = refusedPort;
      await withUpgradeProxy(async (proxyPort, proxyServer) => {
        const {proxySocket, received} = await openRawUpgrade(proxyServer, proxyPort);
        await waitFor(() => received().endsWith('Trace processor WebSocket proxy failed'));
        expect(received().split('\r\n')[0]).toBe('HTTP/1.1 502 Bad Gateway');
        // The upstream's close must not cut the rejection short: the peer gets
        // its linger to read the response, then the socket is released.
        expect(await closedWithin(proxySocket, 250)).toBe(false);
        expect(await closedWithin(proxySocket, REJECTED_UPGRADE_LINGER_MS + 1000)).toBe(true);
        expect(connectSpy).toHaveBeenCalledWith(expect.objectContaining({port: refusedPort}));
      });
    });

    it('drops a tunnel whose upstream resets without writing an HTTP error into it', async () => {
      jest.spyOn(console, 'error').mockImplementation(() => undefined);
      rawServer = await rawUpstream(socket => socket.resetAndDestroy());
      upstreamPort = (rawServer.address() as net.AddressInfo).port;
      await withUpgradeProxy(async (proxyPort, proxyServer) => {
        const {proxySocket, received} = await openRawUpgrade(proxyServer, proxyPort);
        expect(await closedWithin(proxySocket, 2000)).toBe(true);
        expect(received()).not.toContain('HTTP/1.1 502');
      });
    });

    it('closes the client socket when a tunnelled upstream ends', async () => {
      rawServer = await rawUpstream(socket => socket.end());
      upstreamPort = (rawServer.address() as net.AddressInfo).port;
      await withUpgradeProxy(async (proxyPort, proxyServer) => {
        const {proxySocket} = await openRawUpgrade(proxyServer, proxyPort);
        expect(await closedWithin(proxySocket, 500)).toBe(true);
      });
    });
  });

  describe('upgrade Origin policy', () => {
    const SIBLING_ORIGIN = 'https://evil.example.test';
    const sessionPath = () => `/api/tp/${lease.id}/websocket?windowId=window-o`;

    function useSessionIdentity(): void {
      jest.spyOn(EnterpriseSsoService.getInstance(), 'resolveRequestIdentityFromRequest').mockReturnValue({
        userId: 'user-a', email: 'user-a@example.test', subscription: 'enterprise', authType: 'sso',
        tenantId: 'tenant-a', workspaceId: 'workspace-a', roles: ['analyst'], scopes: ['trace:read'],
      });
    }

    function expectNoLeaseWork(): void {
      expect(frontendHolder('window-o')).toBeUndefined();
      expect(exposeNativePortMock).not.toHaveBeenCalled();
    }

    describe('with an OIDC session cookie', () => {
      beforeEach(() => {
        Object.assign(process.env, oidcEnv);
        process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'false';
        useSessionIdentity();
      });

      it('tunnels an upgrade from FRONTEND_URL', async () => {
        await withUpgradeProxy(async proxyPort => {
          expect(await upgradeStatus(proxyPort, sessionPath(), {
            Cookie: 'sp_sso_session=sp_sso_token', Origin: oidcEnv.FRONTEND_URL,
          })).toBe(101);
          expect(frontendHolder('window-o')).toBeDefined();
        });
      });

      it.each([
        ['a same-site sibling origin', {Origin: SIBLING_ORIGIN}],
        ['no Origin', {}],
        ['an opaque Origin', {Origin: 'null'}],
      ])('rejects an upgrade from %s before acquiring a holder', async (_label, headers: Record<string, string>) => {
        await withUpgradeProxy(async proxyPort => {
          expect(await upgradeStatus(proxyPort, sessionPath(), {
            Cookie: 'sp_sso_session=sp_sso_token', ...headers,
          })).toBe(403);
          expectNoLeaseWork();
        });
      });

      it('lets the cookie, not an accompanying capability, decide', async () => {
        const capability = issueTraceProcessorProxyCapability({context: {
          tenantId: 'tenant-a', workspaceId: 'workspace-a', userId: 'user-a', authType: 'sso',
          roles: ['analyst'], scopes: ['trace:read'], requestId: 'capability-request', windowId: 'window-o',
        }, leaseId: lease.id});
        await withUpgradeProxy(async proxyPort => {
          expect(await upgradeStatus(proxyPort, sessionPath(), {
            Cookie: 'sp_sso_session=sp_sso_token',
            'Sec-WebSocket-Protocol': capability.protocol,
            Origin: SIBLING_ORIGIN,
          })).toBe(403);
          expectNoLeaseWork();
        });
      });

      it('does not check the Origin of a bearer session token, which no page attaches ambiently', async () => {
        await withUpgradeProxy(async proxyPort => {
          expect(await upgradeStatus(proxyPort, sessionPath(), {
            Authorization: 'Bearer sp_sso_token', Cookie: 'sp_sso_session=sp_sso_token', Origin: SIBLING_ORIGIN,
          })).toBe(101);
        });
      });
    });

    it('rejects a trusted SSO upgrade from a foreign Origin', async () => {
      await withUpgradeProxy(async proxyPort => {
        const headers = {'X-SmartPerfetto-SSO-User-Id': 'user-a', 'X-SmartPerfetto-SSO-Tenant-Id': 'tenant-a'};
        expect(await upgradeStatus(proxyPort, `${sessionPath()}&workspaceId=workspace-a`, {
          ...headers, Origin: SIBLING_ORIGIN,
        })).toBe(403);
        expectNoLeaseWork();
        expect(await upgradeStatus(proxyPort, `${sessionPath()}&workspaceId=workspace-a`, {
          ...headers, Origin: oidcEnv.FRONTEND_URL,
        })).toBe(101);
      });
    });

    describe('in keyless local mode', () => {
      const devPath = () =>
        `/api/tp/${lease.id}/websocket?tenantId=tenant-a&workspaceId=workspace-a&windowId=window-o&userId=user-a`;

      beforeEach(() => {
        process.env[ENTERPRISE_FEATURE_FLAG_ENV] = 'false';
        process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS = 'false';
      });

      it('tunnels an upgrade from the local UI origin', async () => {
        await withUpgradeProxy(async proxyPort => {
          expect(await upgradeStatus(proxyPort, devPath(), {Origin: 'http://127.0.0.1:10000'})).toBe(101);
        });
      });

      it.each([
        ['another local port', 'http://localhost:3000'],
        ['an opaque origin', 'null'],
      ])('rejects an upgrade from %s', async (_label, origin) => {
        await withUpgradeProxy(async proxyPort => {
          expect(await upgradeStatus(proxyPort, devPath(), {Origin: origin})).toBe(403);
          expectNoLeaseWork();
        });
      });

      // A rebinding page is same-origin with its own Host, so the backend's
      // origin must never be inferred from Host.
      it('rejects a DNS-rebinding upgrade whose Origin matches its Host', async () => {
        await withUpgradeProxy(async proxyPort => {
          expect(await upgradeStatus(proxyPort, devPath(), {
            Host: `evil.example.test:${proxyPort}`, Origin: `http://evil.example.test:${proxyPort}`,
          })).toBe(403);
          expectNoLeaseWork();
        });
      });
    });
  });
});
