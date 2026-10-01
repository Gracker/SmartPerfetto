// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import type { IncomingMessage } from 'http';
import type Database from 'better-sqlite3';
import type { RequestContext, RequestContextAuthType } from '../middleware/auth';
import { sanitizeContextId } from '../utils/contextId';
import { openEnterpriseDb } from './enterpriseDb';
import { recordEnterpriseAuditEvent } from './enterpriseAuditService';

export const ENTERPRISE_API_KEY_PREFIX = 'spak_';

const DEFAULT_API_KEY_SCOPES = ['trace:read', 'trace:write', 'agent:run', 'report:read'];

interface ApiKeyTokenParts {
  id: string;
  secret: string;
}

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  owner_user_id: string | null;
  name: string;
  key_hash: string;
  scopes: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
}

export interface EnterpriseApiKeyRecord {
  id: string;
  tenantId: string;
  workspaceId?: string;
  ownerUserId?: string;
  name: string;
  scopes: string[];
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
  lastUsedAt?: number;
}

export interface CreateEnterpriseApiKeyInput {
  name?: string;
  tenantId?: string;
  workspaceId?: string | null;
  ownerUserId?: string | null;
  scopes?: unknown;
  expiresAt?: unknown;
}

export interface CreatedEnterpriseApiKey {
  apiKey: EnterpriseApiKeyRecord;
  token: string;
}

export interface RequestApiKeyIdentity {
  userId: string;
  email: string;
  subscription: string;
  authType: RequestContextAuthType;
  tenantId: string;
  workspaceId?: string;
  roles: string[];
  scopes: string[];
}

function nowMs(): number {
  return Date.now();
}

function sanitizeScope(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (trimmed === '*') return '*';
  return trimmed.replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 128);
}

function safeText(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim().replace(/[\r\n]/g, '').slice(0, 120);
  return trimmed || fallback;
}

function normalizeScopes(input: unknown, fallback = DEFAULT_API_KEY_SCOPES): string[] {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,\s]+/)
      : [];
  const scopes = raw
    .map(scope => sanitizeScope(scope))
    .filter(Boolean);
  return scopes.length > 0 ? [...new Set(scopes)] : [...fallback];
}

function parseScopes(value: string): string[] {
  try {
    return normalizeScopes(JSON.parse(value), []);
  } catch {
    return normalizeScopes(value, []);
  }
}

function normalizeExpiresAt(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value.trim())
      ? Number.parseInt(value, 10)
      : Date.parse(String(value));
  if (!Number.isFinite(parsed)) {
    throw new Error('expiresAt must be a Unix millisecond timestamp or ISO date string');
  }
  if (parsed <= nowMs()) {
    throw new Error('expiresAt must be in the future');
  }
  return parsed;
}

function hashTokenSecret(id: string, secret: string): string {
  return crypto.createHash('sha256').update(`${id}.${secret}`).digest('hex');
}

function safeEquals(a: string, b: string): boolean {
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  return aBuf.length === bBuf.length && crypto.timingSafeEqual(aBuf, bBuf);
}

function parseApiKeyToken(token: string | undefined): ApiKeyTokenParts | null {
  if (!token?.startsWith(ENTERPRISE_API_KEY_PREFIX)) return null;
  const payload = token.slice(ENTERPRISE_API_KEY_PREFIX.length);
  const separator = payload.indexOf('.');
  if (separator <= 0) return null;
  const id = payload.slice(0, separator);
  const secret = payload.slice(separator + 1);
  return sanitizeContextId(id) === id && secret.length >= 32 ? { id, secret } : null;
}

export function extractEnterpriseApiKeyToken(req: IncomingMessage): string | undefined {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim();
    if (token.startsWith(ENTERPRISE_API_KEY_PREFIX)) return token;
  }
  const headerKey = req.headers['x-api-key'];
  if (typeof headerKey === 'string' && headerKey.trim().startsWith(ENTERPRISE_API_KEY_PREFIX)) {
    return headerKey.trim();
  }
  return undefined;
}

export function requestHasEnterpriseApiKeyCredential(req: IncomingMessage): boolean {
  return Boolean(extractEnterpriseApiKeyToken(req));
}

function rowToRecord(row: ApiKeyRow): EnterpriseApiKeyRecord {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
    ...(row.owner_user_id ? { ownerUserId: row.owner_user_id } : {}),
    name: row.name,
    scopes: parseScopes(row.scopes),
    createdAt: row.created_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
  };
}

export class EnterpriseApiKeyService {
  private static instance: EnterpriseApiKeyService | undefined;

  constructor(private readonly db: Database.Database = openEnterpriseDb()) {}

  static getInstance(): EnterpriseApiKeyService {
    if (!EnterpriseApiKeyService.instance) {
      EnterpriseApiKeyService.instance = new EnterpriseApiKeyService();
    }
    return EnterpriseApiKeyService.instance;
  }

  static resetForTests(): void {
    EnterpriseApiKeyService.instance = undefined;
  }

  static setInstanceForTests(service: EnterpriseApiKeyService): void {
    EnterpriseApiKeyService.instance = service;
  }

  createApiKey(context: RequestContext, input: CreateEnterpriseApiKeyInput = {}): CreatedEnterpriseApiKey {
    const canDelegateOrg = context.roles.includes('org_admin')
      || context.scopes.includes('*')
      || context.scopes.includes('api_key:delegate_org');
    const requestedTenantId = sanitizeContextId(input.tenantId);
    if (requestedTenantId && requestedTenantId !== context.tenantId) {
      throw new Error('tenantId must match the authenticated RequestContext');
    }
    const requestedWorkspaceId = sanitizeContextId(input.workspaceId);
    if (requestedWorkspaceId && requestedWorkspaceId !== context.workspaceId) {
      throw new Error('workspaceId must match the authenticated RequestContext');
    }
    if (input.workspaceId === null && !canDelegateOrg) {
      throw new Error('Only an org admin can create a tenant-wide API key');
    }
    if (input.ownerUserId === null) {
      throw new Error('API keys must retain an accountable owner');
    }
    const requestedOwnerUserId = sanitizeContextId(input.ownerUserId) || context.userId;
    if (requestedOwnerUserId !== context.userId && !canDelegateOrg) {
      throw new Error('Only an org admin can create an API key for another user');
    }
    const tenantId = context.tenantId;
    const workspaceId = input.workspaceId === null ? undefined : context.workspaceId;
    const ownerUserId = this.existingUserId(tenantId, requestedOwnerUserId);
    if (!ownerUserId) throw new Error('API key owner must be an active tenant user');
    const scopes = normalizeScopes(input.scopes);
    if (!canDelegateOrg) {
      if (scopes.includes('*')) {
        throw new Error('Workspace administrators cannot delegate wildcard scope');
      }
      const callerScopes = new Set(context.scopes);
      const unsupportedScope = scopes.find(scope => !callerScopes.has(scope));
      if (unsupportedScope) {
        throw new Error(`Cannot delegate scope not held by caller: ${unsupportedScope}`);
      }
    }
    const expiresAt = normalizeExpiresAt(input.expiresAt);
    const id = `ak_${crypto.randomUUID()}`;
    const secret = crypto.randomBytes(32).toString('base64url');
    const createdAt = nowMs();

    this.db.prepare(`
      INSERT INTO api_keys
        (id, tenant_id, workspace_id, owner_user_id, name, key_hash, scopes, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      tenantId,
      workspaceId ?? null,
      ownerUserId ?? null,
      safeText(input.name, 'API key'),
      hashTokenSecret(id, secret),
      JSON.stringify(scopes),
      createdAt,
      expiresAt ?? null,
    );

    recordEnterpriseAuditEvent(this.db, {
      tenantId,
      workspaceId,
      actorUserId: this.existingUserId(tenantId, context.userId),
      action: 'api_key_created',
      resourceType: 'api_key',
      resourceId: id,
      metadata: {
        name: safeText(input.name, 'API key'),
        scopes,
        expiresAt,
        ownerUserId,
      },
    });

    const row = this.getRow(id);
    if (!row) throw new Error('API key was not persisted');
    return {
      apiKey: rowToRecord(row),
      token: `${ENTERPRISE_API_KEY_PREFIX}${id}.${secret}`,
    };
  }

  listApiKeys(context: RequestContext): EnterpriseApiKeyRecord[] {
    if (this.canManageOrgKeys(context)) {
      return this.db.prepare<unknown[], ApiKeyRow>(`
        SELECT *
        FROM api_keys
        WHERE tenant_id = ?
        ORDER BY created_at DESC
      `).all(context.tenantId).map(rowToRecord);
    }
    return this.db.prepare<unknown[], ApiKeyRow>(`
      SELECT *
      FROM api_keys
      WHERE tenant_id = ?
        AND workspace_id = ?
      ORDER BY created_at DESC
    `).all(context.tenantId, context.workspaceId).map(rowToRecord);
  }

  revokeApiKey(context: RequestContext, idInput: string): EnterpriseApiKeyRecord | null {
    const id = sanitizeContextId(idInput);
    const existing = id ? this.getRowForContext(context, id) : null;
    if (!existing || existing.revoked_at) return null;
    const revokedAt = nowMs();
    this.db.prepare(`
      UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
    `).run(revokedAt, existing.id);

    recordEnterpriseAuditEvent(this.db, {
      tenantId: existing.tenant_id,
      workspaceId: existing.workspace_id ?? undefined,
      actorUserId: this.existingUserId(existing.tenant_id, context.userId),
      action: 'api_key_revoked',
      resourceType: 'api_key',
      resourceId: existing.id,
      metadata: {
        ownerUserId: existing.owner_user_id,
        scopes: parseScopes(existing.scopes),
      },
    });

    const row = this.getRow(existing.id);
    return row ? rowToRecord(row) : null;
  }

  resolveRequestIdentityFromRequest(req: IncomingMessage): RequestApiKeyIdentity | null {
    const parts = parseApiKeyToken(extractEnterpriseApiKeyToken(req));
    if (!parts) return null;
    const row = this.getRow(parts.id);
    if (!row || row.revoked_at || (row.expires_at && row.expires_at <= nowMs())) return null;
    const expectedHash = hashTokenSecret(parts.id, parts.secret);
    if (!safeEquals(row.key_hash, expectedHash)) return null;
    this.db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(nowMs(), row.id);
    return {
      userId: row.owner_user_id || row.id,
      email: '',
      subscription: 'enterprise',
      authType: 'api_key',
      tenantId: row.tenant_id,
      ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
      roles: ['api_key'],
      scopes: parseScopes(row.scopes),
    };
  }

  private getRow(id: string): ApiKeyRow | null {
    return this.db.prepare<unknown[], ApiKeyRow>('SELECT * FROM api_keys WHERE id = ?').get(id) || null;
  }

  private getRowForContext(context: RequestContext, id: string): ApiKeyRow | null {
    if (this.canManageOrgKeys(context)) {
      return this.db.prepare<unknown[], ApiKeyRow>(`
        SELECT * FROM api_keys WHERE id = ? AND tenant_id = ?
      `).get(id, context.tenantId) || null;
    }
    return this.db.prepare<unknown[], ApiKeyRow>(`
      SELECT *
      FROM api_keys
      WHERE id = ?
        AND tenant_id = ?
        AND workspace_id = ?
    `).get(id, context.tenantId, context.workspaceId) || null;
  }

  private canManageOrgKeys(context: RequestContext): boolean {
    return context.roles.includes('org_admin')
      || context.scopes.includes('*')
      || context.scopes.includes('api_key:delegate_org');
  }

  private existingUserId(tenantId: string, userId: string | undefined): string | undefined {
    if (!userId) return undefined;
    const row = this.db.prepare<unknown[], { id: string }>(
      'SELECT id FROM users WHERE tenant_id = ? AND id = ?',
    ).get(tenantId, userId);
    return row?.id;
  }
}
