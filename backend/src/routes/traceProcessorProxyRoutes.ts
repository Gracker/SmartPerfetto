// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import express, { Router, type Request, type Response } from 'express';
import type { IncomingMessage } from 'http';
import net, { type Socket } from 'net';
import type { Duplex } from 'stream';
import { resolveFeatureConfig, serverConfig } from '../config';
import {
  authenticate,
  DEFAULT_DEV_USER_ID,
  DEFAULT_TENANT_ID,
  DEFAULT_WORKSPACE_ID,
  requireRequestContext,
  type RequestContext,
  type RequestContextAuthType,
} from '../middleware/auth';
import { getTraceProcessorService } from '../services/traceProcessorService';
import {
  getTraceProcessorLeaseStore,
  type FrontendHolderVisibility,
  type TraceProcessorHolderInput,
  type TraceProcessorLeaseRecord,
  type TraceProcessorLeaseState,
} from '../services/traceProcessorLeaseStore';
import { normalizeTraceProcessorQueryPriority } from '../services/traceProcessorSqlWorker';
import { hasRbacPermission, sendForbidden } from '../services/rbac';
import { EnterpriseSsoService } from '../services/enterpriseSsoService';
import { EnterpriseApiKeyService } from '../services/enterpriseApiKeyService';
import type { EnterpriseRepositoryScope } from '../services/enterpriseRepository';
import {
  issueTraceProcessorProxyCapability,
  resolveTraceProcessorProxyCapability,
  stripTraceProcessorCapabilityProtocols,
} from '../services/traceProcessorProxyCapability';

const router = Router();
const READY_STATES = new Set<TraceProcessorLeaseState>(['ready', 'idle', 'active']);
const CONFLICT_STATES = new Set<TraceProcessorLeaseState>(['draining', 'released', 'failed']);
const FRONTEND_VISIBILITIES = new Set<FrontendHolderVisibility>(['visible', 'hidden', 'offline']);
const TRACE_PROCESSOR_INTERNAL_ORIGIN = 'http://127.0.0.1:10000';
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

class TraceProcessorProxyError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
    this.name = 'TraceProcessorProxyError';
  }
}

interface RequestIdentity {
  userId: string;
  authType: RequestContextAuthType;
  tenantId?: string;
  workspaceId?: string;
  roles?: string[];
  scopes?: string[];
}

interface ProxyTarget {
  lease: TraceProcessorLeaseRecord;
  port: number;
  scope: EnterpriseRepositoryScope;
}

function sanitizeContextId(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 128);
}

function getHeader(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] || '';
  return typeof value === 'string' ? value : '';
}

function getFirstHeader(req: IncomingMessage, names: string[]): string {
  for (const name of names) {
    const value = getHeader(req, name);
    if (value.trim()) return value;
  }
  return '';
}

function parseHeaderList(req: IncomingMessage, names: string[], fallback: string[]): string[] {
  const raw = getFirstHeader(req, names);
  if (!raw.trim()) return fallback;
  const parsed = raw
    .split(',')
    .map(value => sanitizeContextId(value))
    .filter(Boolean);
  return parsed.length > 0 ? parsed : fallback;
}

function trustedHeadersEnabled(): boolean {
  const value = process.env.SMARTPERFETTO_SSO_TRUSTED_HEADERS;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value || '').trim().toLowerCase());
}

function defaultRolesForAuthType(authType: RequestContextAuthType): string[] {
  return authType === 'dev' ? ['org_admin'] : ['analyst'];
}

function defaultScopesForAuthType(authType: RequestContextAuthType): string[] {
  return authType === 'dev'
    ? ['*']
    : ['trace:read', 'trace:write', 'agent:run', 'report:read'];
}

function resolveTrustedSsoIdentity(req: IncomingMessage): RequestIdentity | null {
  if (!trustedHeadersEnabled()) return null;
  const userId = sanitizeContextId(getFirstHeader(req, [
    'x-smartperfetto-sso-user-id',
    'x-sso-user-id',
    'x-auth-request-user',
  ]));
  if (!userId) return null;

  return {
    userId,
    authType: 'sso',
    tenantId: sanitizeContextId(getFirstHeader(req, [
      'x-smartperfetto-sso-tenant-id',
      'x-sso-tenant-id',
      'x-tenant-id',
    ])) || undefined,
    workspaceId: sanitizeContextId(getFirstHeader(req, [
      'x-smartperfetto-sso-workspace-id',
      'x-sso-workspace-id',
      'x-workspace-id',
    ])) || undefined,
    roles: parseHeaderList(req, [
      'x-smartperfetto-sso-roles',
      'x-sso-roles',
    ], defaultRolesForAuthType('sso')),
    scopes: parseHeaderList(req, [
      'x-smartperfetto-sso-scopes',
      'x-sso-scopes',
    ], defaultScopesForAuthType('sso')),
  };
}

function queryValue(req: IncomingMessage, key: string): string {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  return sanitizeContextId(url.searchParams.get(key) || '');
}

function contextFromIdentity(req: IncomingMessage, identity: RequestIdentity): RequestContext {
  const authType = identity.authType;
  const requestId =
    sanitizeContextId(getHeader(req, 'x-request-id')) ||
    `ws-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const windowId =
    sanitizeContextId(getHeader(req, 'x-window-id')) ||
    queryValue(req, 'windowId') ||
    undefined;

  return {
    tenantId:
      identity.tenantId ||
      sanitizeContextId(getFirstHeader(req, ['x-tenant-id', 'x-sso-tenant-id'])) ||
      queryValue(req, 'tenantId') ||
      DEFAULT_TENANT_ID,
    workspaceId:
      identity.workspaceId ||
      sanitizeContextId(getFirstHeader(req, ['x-workspace-id', 'x-sso-workspace-id'])) ||
      queryValue(req, 'workspaceId') ||
      DEFAULT_WORKSPACE_ID,
    userId: identity.userId,
    authType,
    roles: identity.roles ?? defaultRolesForAuthType(authType),
    scopes: identity.scopes ?? defaultScopesForAuthType(authType),
    requestId,
    ...(windowId ? { windowId } : {}),
  };
}

function resolveUpgradeRequestContext(req: IncomingMessage, leaseId: string): RequestContext | null {
  const trustedIdentity = resolveTrustedSsoIdentity(req);
  if (trustedIdentity) return contextFromIdentity(req, trustedIdentity);

  try {
    const ssoIdentity = EnterpriseSsoService.getInstance()
      .resolveRequestIdentityFromRequest(req as Request);
    if (ssoIdentity) return contextFromIdentity(req, ssoIdentity);
  } catch {
    // Fall through to API key or dev fallback.
  }

  try {
    const apiKeyIdentity = EnterpriseApiKeyService.getInstance()
      .resolveRequestIdentityFromRequest(req as Request);
    if (apiKeyIdentity) return contextFromIdentity(req, apiKeyIdentity);
  } catch {
    // Fall through to dev fallback.
  }

  const capabilityContext = resolveTraceProcessorProxyCapability(
    req.headers['sec-websocket-protocol'],
    leaseId,
  );
  if (capabilityContext) return capabilityContext;

  if (!resolveFeatureConfig().enterprise && !process.env.SMARTPERFETTO_API_KEY?.trim()) {
    return contextFromIdentity(req, {
      userId: queryValue(req, 'userId') || DEFAULT_DEV_USER_ID,
      authType: 'dev',
    });
  }

  return null;
}

function leaseScopeFromContext(context: RequestContext) {
  return {
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    userId: context.userId,
  };
}

function frontendHolderForContext(
  context: RequestContext,
  metadata: Record<string, unknown> = {},
  frontendVisibility?: FrontendHolderVisibility,
): TraceProcessorHolderInput {
  const holderRef = context.windowId || context.requestId || context.userId;
  return {
    holderType: 'frontend_http_rpc',
    holderRef,
    windowId: context.windowId,
    ...(frontendVisibility ? { frontendVisibility } : {}),
    metadata: {
      requestId: context.requestId,
      proxy: 'trace_processor',
      ...metadata,
    },
  };
}

function parseFrontendVisibility(value: unknown): FrontendHolderVisibility {
  if (value === undefined || value === null || value === '') return 'visible';
  if (typeof value !== 'string') {
    throw new TraceProcessorProxyError(400, 'frontend visibility must be visible, hidden, or offline');
  }
  const normalized = value.trim().toLowerCase();
  if (FRONTEND_VISIBILITIES.has(normalized as FrontendHolderVisibility)) {
    return normalized as FrontendHolderVisibility;
  }
  throw new TraceProcessorProxyError(400, 'frontend visibility must be visible, hidden, or offline');
}

function ensureTraceRead(context: RequestContext): void {
  if (!hasRbacPermission(context, 'trace:read')) {
    throw new TraceProcessorProxyError(403, 'Trace processor proxy requires trace:read permission');
  }
}

function ensureRuntimeManage(context: RequestContext): void {
  if (!hasRbacPermission(context, 'runtime:manage')) {
    throw new TraceProcessorProxyError(403, 'Trace processor lease admin requires runtime:manage permission');
  }
}

function leaseAdminReason(req: Request): string | undefined {
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
  return reason ? reason.slice(0, 500) : undefined;
}

async function resolveProxyTargetForContext(
  context: RequestContext,
  leaseId: string,
  holderMetadata: Record<string, unknown> = {},
): Promise<ProxyTarget> {
  ensureTraceRead(context);

  const store = getTraceProcessorLeaseStore();
  const scope = leaseScopeFromContext(context);
  let lease = store.getLeaseById(scope, leaseId);
  if (!lease) {
    throw new TraceProcessorProxyError(404, 'Trace processor lease not found');
  }
  if (CONFLICT_STATES.has(lease.state)) {
    throw new TraceProcessorProxyError(409, `Trace processor lease is ${lease.state}`);
  }

  lease = store.acquireHolderForLease(scope, lease.id, frontendHolderForContext(context, holderMetadata));

  if (!READY_STATES.has(lease.state)) {
    throw new TraceProcessorProxyError(503, `Trace processor lease is not ready (${lease.state})`);
  }

  const traceProcessorService = getTraceProcessorService();
  const trace = await traceProcessorService.getOrLoadTrace(lease.traceId);
  if (!trace) {
    throw new TraceProcessorProxyError(404, 'Trace not found for trace processor lease');
  }

  await traceProcessorService.ensureProcessorForLease(lease.traceId, lease.id, lease.mode, scope);
  const traceWithPort = traceProcessorService.getTraceWithLeasePort(lease.traceId, lease.id, lease.mode);
  if (!traceWithPort?.port) {
    throw new TraceProcessorProxyError(503, 'Trace processor HTTP RPC port is not ready');
  }

  return {
    lease,
    port: traceWithPort.port,
    scope,
  };
}

async function resolveProxyTarget(req: Request, leaseId: string): Promise<ProxyTarget> {
  const context = requireRequestContext(req);
  return resolveProxyTargetForContext(context, leaseId);
}

function copyUpstreamResponseHeaders(upstream: globalThis.Response, res: Response): void {
  for (const [name, value] of upstream.headers.entries()) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    if (name.toLowerCase() === 'content-length') continue;
    res.setHeader(name, value);
  }
}

function requestBody(req: Request): Buffer | undefined {
  if (Buffer.isBuffer(req.body)) return req.body;
  if (req.body instanceof Uint8Array) return Buffer.from(req.body);
  return undefined;
}

function upstreamRequestHeaders(req: Request, body: Buffer | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  const contentType = req.get('content-type');
  if (contentType) headers['content-type'] = contentType;
  const accept = req.get('accept');
  if (accept) headers.accept = accept;
  if (body) headers['content-length'] = String(body.length);
  return headers;
}

async function forwardHttpRpc(req: Request, res: Response, upstreamPath: '/status' | '/query'): Promise<void> {
  const leaseId = sanitizeContextId(req.params.leaseId);
  if (!leaseId) {
    res.status(400).json({ success: false, error: 'leaseId is required' });
    return;
  }

  const target = await resolveProxyTarget(req, leaseId);
  const body = requestBody(req);
  const upstream = await fetch(`http://127.0.0.1:${target.port}${upstreamPath}`, {
    method: 'POST',
    headers: upstreamRequestHeaders(req, body),
    ...(body ? { body } : {}),
  });
  const responseBody = Buffer.from(await upstream.arrayBuffer());
  copyUpstreamResponseHeaders(upstream, res);
  res.status(upstream.status).send(responseBody);
}

async function forwardQueryRpc(req: Request, res: Response): Promise<void> {
  const leaseId = sanitizeContextId(req.params.leaseId);
  if (!leaseId) {
    res.status(400).json({ success: false, error: 'leaseId is required' });
    return;
  }

  const body = requestBody(req);
  if (!body) {
    res.status(400).json({ success: false, error: 'query protobuf body is required' });
    return;
  }

  const priority = normalizeTraceProcessorQueryPriority(
    req.get('x-smartperfetto-query-priority') || req.query.priority,
    'p0',
  );
  const target = await resolveProxyTargetForContext(requireRequestContext(req), leaseId, {
    lastQueryAt: Date.now(),
    queryPriority: priority,
  });
  const controller = new AbortController();
  const abort = () => controller.abort(new Error('Trace processor proxy client disconnected'));
  req.once('aborted', abort);
  res.once('close', abort);
  let responseBody: Buffer;
  try {
    responseBody = await getTraceProcessorService().queryRaw(target.lease.traceId, body, {
      priority,
      leaseId: target.lease.id,
      leaseMode: target.lease.mode,
      leaseScope: target.scope,
      signal: controller.signal,
    });
  } finally {
    req.off('aborted', abort);
    res.off('close', abort);
  }
  res.setHeader('content-type', 'application/x-protobuf');
  res.status(200).send(responseBody);
}

async function heartbeatLease(req: Request, res: Response): Promise<void> {
  const leaseId = sanitizeContextId(req.params.leaseId);
  if (!leaseId) {
    res.status(400).json({ success: false, error: 'leaseId is required' });
    return;
  }

  const context = requireRequestContext(req);
  ensureTraceRead(context);
  const visibility = parseFrontendVisibility(req.body?.visibility);
  const scope = leaseScopeFromContext(context);
  const store = getTraceProcessorLeaseStore();
  let lease = store.getLeaseById(scope, leaseId);
  if (!lease) {
    throw new TraceProcessorProxyError(404, 'Trace processor lease not found');
  }
  if (CONFLICT_STATES.has(lease.state)) {
    throw new TraceProcessorProxyError(409, `Trace processor lease is ${lease.state}`);
  }

  const holder = frontendHolderForContext(context, {
    heartbeat: 'frontend',
    lastHeartbeatAt: Date.now(),
  }, visibility);
  try {
    lease = store.acquireHolderForLease(scope, lease.id, holder);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('not acquirable')) {
      throw new TraceProcessorProxyError(409, message);
    }
    if (message.includes('not found')) {
      throw new TraceProcessorProxyError(404, 'Trace processor lease not found');
    }
    throw error;
  }

  res.json({
    success: true,
    action: 'heartbeat',
    lease,
    holder: {
      holderType: holder.holderType,
      holderRef: holder.holderRef,
      windowId: holder.windowId ?? null,
      frontendVisibility: visibility,
    },
    websocketCapability: issueTraceProcessorProxyCapability({
      context,
      leaseId: lease.id,
    }),
  });
}

async function drainLease(req: Request, res: Response): Promise<void> {
  const leaseId = sanitizeContextId(req.params.leaseId);
  if (!leaseId) {
    res.status(400).json({ success: false, error: 'leaseId is required' });
    return;
  }

  const context = requireRequestContext(req);
  ensureRuntimeManage(context);
  const scope = leaseScopeFromContext(context);
  const store = getTraceProcessorLeaseStore();
  const lease = store.getLeaseById(scope, leaseId);
  if (!lease) {
    throw new TraceProcessorProxyError(404, 'Trace processor lease not found');
  }
  if (lease.state === 'released' || lease.state === 'failed') {
    throw new TraceProcessorProxyError(409, `Trace processor lease is ${lease.state}`);
  }

  const drained = store.beginDraining(scope, lease.id);
  res.json({
    success: true,
    action: 'drain',
    reason: leaseAdminReason(req),
    lease: drained,
  });
}

async function restartLease(req: Request, res: Response): Promise<void> {
  const leaseId = sanitizeContextId(req.params.leaseId);
  if (!leaseId) {
    res.status(400).json({ success: false, error: 'leaseId is required' });
    return;
  }

  const context = requireRequestContext(req);
  ensureRuntimeManage(context);
  const scope = leaseScopeFromContext(context);
  const store = getTraceProcessorLeaseStore();
  const lease = store.getLeaseById(scope, leaseId);
  if (!lease) {
    throw new TraceProcessorProxyError(404, 'Trace processor lease not found');
  }
  if (CONFLICT_STATES.has(lease.state)) {
    throw new TraceProcessorProxyError(409, `Trace processor lease is ${lease.state}`);
  }

  const traceProcessorService = getTraceProcessorService();
  const trace = await traceProcessorService.getOrLoadTrace(lease.traceId);
  if (!trace) {
    throw new TraceProcessorProxyError(404, 'Trace not found for trace processor lease');
  }

  await traceProcessorService.restartLease(lease.traceId, lease.id, lease.mode, scope);
  const restarted = store.getLeaseById(scope, lease.id);
  res.json({
    success: true,
    action: 'restart',
    reason: leaseAdminReason(req),
    lease: restarted,
  });
}

function sendProxyError(res: Response, error: unknown): void {
  if (error instanceof TraceProcessorProxyError) {
    if (error.statusCode === 403) {
      sendForbidden(res, error.message);
      return;
    }
    res.status(error.statusCode).json({
      success: false,
      error: error.message,
    });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error('[TraceProcessorProxy] Proxy error:', message);
  res.status(502).json({
    success: false,
    error: 'Trace processor proxy failed',
    details: message,
  });
}

function writeUpgradeError(socket: Duplex, statusCode: number, message: string): void {
  if (!socket.writable) return;
  socket.write(
    `HTTP/1.1 ${statusCode} ${message}\r\n`
    + 'Connection: close\r\n'
    + 'Content-Type: text/plain; charset=utf-8\r\n'
    + `Content-Length: ${Buffer.byteLength(message)}\r\n`
    + '\r\n'
    + message,
  );
  socket.end();
}

function websocketRequestHeaders(req: IncomingMessage, targetPort: number): string[] {
  const headers = [
    `Host: 127.0.0.1:${targetPort}`,
    'Connection: Upgrade',
    'Upgrade: websocket',
    `Origin: ${TRACE_PROCESSOR_INTERNAL_ORIGIN}`,
  ];

  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const value = req.rawHeaders[i + 1];
    if (!name || value === undefined) continue;
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    // The browser Origin belongs to the authenticated public proxy boundary.
    // Normalize it to the standard loopback Perfetto UI origin accepted by
    // trace_processor_shell rather than forwarding an arbitrary public port.
    if (name.toLowerCase() === 'origin') continue;
    if (name.toLowerCase() === 'sec-websocket-protocol') {
      const upstreamProtocols = stripTraceProcessorCapabilityProtocols(value);
      if (upstreamProtocols.length > 0) {
        headers.push(`Sec-WebSocket-Protocol: ${upstreamProtocols.join(', ')}`);
      }
      continue;
    }
    headers.push(`${name}: ${value}`);
  }

  return headers;
}

function requestedTraceProcessorCapabilityProtocol(
  req: IncomingMessage,
  leaseId: string,
): string | undefined {
  const raw = req.headers['sec-websocket-protocol'];
  const protocols = (Array.isArray(raw) ? raw : [raw ?? ''])
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean);
  return protocols.find(protocol =>
    resolveTraceProcessorProxyCapability(protocol, leaseId) !== null,
  );
}

function forwardWebSocketHandshake(
  upstream: Socket,
  socket: Duplex,
  capabilityProtocol: string,
): void {
  const chunks: Buffer[] = [];
  let totalBytes = 0;
  const maxHandshakeBytes = 64 * 1024;

  const onData = (chunk: Buffer): void => {
    chunks.push(chunk);
    totalBytes += chunk.length;
    const response = Buffer.concat(chunks, totalBytes);
    const headerEnd = response.indexOf('\r\n\r\n');
    if (headerEnd < 0) {
      if (totalBytes > maxHandshakeBytes) {
        upstream.destroy(new Error('Trace processor WebSocket handshake is too large'));
      }
      return;
    }

    upstream.pause();
    upstream.off('data', onData);
    socket.write(Buffer.concat([
      response.subarray(0, headerEnd),
      Buffer.from(`\r\nSec-WebSocket-Protocol: ${capabilityProtocol}`),
      response.subarray(headerEnd),
    ]));
    upstream.pipe(socket);
    upstream.resume();
  };

  upstream.on('data', onData);
}

async function proxyWebSocket(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  leaseId: string,
): Promise<void> {
  const context = resolveUpgradeRequestContext(req, leaseId);
  if (!context) {
    throw new TraceProcessorProxyError(401, 'Trace processor WebSocket requires authentication');
  }

  const target = await resolveProxyTargetForContext(context, leaseId, {
    websocketConnectedAt: Date.now(),
  });
  const upstream = net.connect({
    host: '127.0.0.1',
    port: target.port,
  });

  upstream.once('connect', () => {
    const capabilityProtocol = requestedTraceProcessorCapabilityProtocol(req, leaseId);
    const request = [
      'GET /websocket HTTP/1.1',
      ...websocketRequestHeaders(req, target.port),
      '',
      '',
    ].join('\r\n');
    upstream.write(request);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    if (capabilityProtocol) {
      forwardWebSocketHandshake(upstream, socket, capabilityProtocol);
    } else {
      upstream.pipe(socket);
    }
  });

  upstream.once('error', (error) => {
    if (!socket.destroyed) {
      writeUpgradeError(socket, 502, `Trace processor WebSocket proxy failed: ${error.message}`);
    }
  });
  socket.once('error', () => upstream.destroy());
  socket.once('close', () => upstream.destroy());
  upstream.once('close', () => socket.destroy());
}

router.use(authenticate);

router.post('/:leaseId/status', express.raw({ type: '*/*', limit: serverConfig.bodyLimit }), async (req, res) => {
  try {
    await forwardHttpRpc(req, res, '/status');
  } catch (error) {
    sendProxyError(res, error);
  }
});

router.post('/:leaseId/query', express.raw({ type: '*/*', limit: serverConfig.bodyLimit }), async (req, res) => {
  try {
    await forwardQueryRpc(req, res);
  } catch (error) {
    sendProxyError(res, error);
  }
});

router.post('/:leaseId/heartbeat', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    await heartbeatLease(req, res);
  } catch (error) {
    sendProxyError(res, error);
  }
});

router.post('/:leaseId/drain', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    await drainLease(req, res);
  } catch (error) {
    sendProxyError(res, error);
  }
});

router.post('/:leaseId/restart', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    await restartLease(req, res);
  } catch (error) {
    sendProxyError(res, error);
  }
});

export function handleTraceProcessorProxyUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): boolean {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  const match = url.pathname.match(/^\/api\/tp\/([^/]+)\/websocket$/);
  if (!match) return false;

  const leaseId = sanitizeContextId(decodeURIComponent(match[1]));
  if (!leaseId) {
    writeUpgradeError(socket, 400, 'leaseId is required');
    return true;
  }

  void proxyWebSocket(req, socket, head, leaseId).catch((error) => {
    if (error instanceof TraceProcessorProxyError) {
      writeUpgradeError(socket, error.statusCode, error.message);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error('[TraceProcessorProxy] WebSocket proxy error:', message);
    writeUpgradeError(socket, 502, 'Trace processor WebSocket proxy failed');
  });
  return true;
}

export default router;
