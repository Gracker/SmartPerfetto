// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import type { Request } from 'express';
import type Database from 'better-sqlite3';
import { resolveFeatureConfig } from '../config';
import type { RequestContextAuthType } from '../middleware/auth';
import {
  listEnterpriseAuditEvents,
  recordEnterpriseAuditEvent,
  type EnterpriseAuditInput,
  type EnterpriseAuditRow,
} from './enterpriseAuditService';
import { openEnterpriseDb } from './enterpriseDb';
import type { EnterpriseOidcUserInfo } from './enterpriseOidcClient';

const SESSION_COOKIE_NAME = 'sp_sso_session';
const STATE_COOKIE_NAME = 'sp_oidc_state';
const SESSION_TOKEN_PREFIX = 'sp_sso_';
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export interface WorkspaceMembership {
  workspaceId: string;
  name: string;
  role: string;
}

interface StoredSsoSession {
  id: string;
  tenantId: string;
  workspaceId?: string;
  userId: string;
  selectedWorkspaceId?: string;
  authContext: {
    authType: RequestContextAuthType;
    roles: string[];
    scopes: string[];
    email?: string;
    displayName?: string;
  };
  createdAt: number;
  expiresAt: number;
  revokedAt?: number;
}

export interface OidcStatePayload {
  state: string;
  nonce: string;
  codeVerifier?: string;
  returnTo?: string;
  createdAt: number;
}

export type OnboardingStatus =
  | 'ready'
  | 'needs_workspace_selection'
  | 'needs_tenant_join'
  | 'no_workspace_membership';

export interface OnboardingResult {
  status: OnboardingStatus;
  accessToken?: string;
  sessionId?: string;
  tenantId?: string;
  userId?: string;
  workspaceId?: string;
  expiresAt?: number;
  workspaces?: WorkspaceMembership[];
  reason?: string;
}

export interface RequestSsoIdentity {
  userId: string;
  email: string;
  subscription: string;
  authType: RequestContextAuthType;
  tenantId: string;
  workspaceId: string;
  roles: string[];
  scopes: string[];
}

export interface EnterpriseSsoSessionSummary {
  authenticated: true;
  status: Exclude<OnboardingStatus, 'needs_tenant_join'>;
  tenantId: string;
  userId: string;
  workspaceId?: string;
  email?: string;
  displayName?: string;
  roles: string[];
  scopes: string[];
  workspaces: WorkspaceMembership[];
  expiresAt: number;
}

function nowMs(): number {
  return Date.now();
}

function sanitizeId(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/[^a-zA-Z0-9._:-]/g, '').slice(0, 128);
}

function safeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.replace(/[\r\n]/g, '').slice(0, 320) : undefined;
}

function hmac(value: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name) cookies.set(name, decodeURIComponent(value));
  }
  return cookies;
}

function bearerTokenFromRequest(req: Request): string | undefined {
  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice('Bearer '.length).trim();
  }
  return undefined;
}

function claimString(userInfo: EnterpriseOidcUserInfo, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = userInfo.claims[key];
    const sanitized = safeString(value);
    if (sanitized) return sanitized;
  }
  return undefined;
}

function parseDomainTenantMap(value: string | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!value) return map;
  const trimmed = value.trim();
  if (!trimmed) return map;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    for (const [domain, tenantId] of Object.entries(parsed)) {
      const sanitizedTenant = sanitizeId(tenantId);
      if (domain.trim() && sanitizedTenant) {
        map.set(domain.trim().toLowerCase(), sanitizedTenant);
      }
    }
    return map;
  } catch {
    // Fall through to comma-separated "example.com=tenant-a" parsing.
  }

  for (const entry of trimmed.split(',')) {
    const [domain, tenantId] = entry.split('=').map(part => part?.trim());
    const sanitizedTenant = sanitizeId(tenantId);
    if (domain && sanitizedTenant) {
      map.set(domain.toLowerCase(), sanitizedTenant);
    }
  }
  return map;
}

function scopesForRole(role: string): string[] {
  if (role === 'org_admin' || role === 'workspace_admin') return ['*'];
  if (role === 'viewer') return ['trace:read', 'report:read'];
  return ['trace:read', 'trace:write', 'agent:run', 'report:read'];
}

export function normalizeOidcReturnTo(
  value: unknown,
  allowedOrigins: ReadonlySet<string> = new Set(),
): string | undefined {
  const candidate = safeString(value);
  if (!candidate) return undefined;
  if (candidate.startsWith('/') && !candidate.startsWith('//')) {
    // WHATWG URL parsing treats backslashes as path separators for HTTP(S)
    // URLs. Without this check, `/\attacker.example` becomes an external URL.
    if (candidate.includes('\\')) return undefined;
    try {
      const base = new URL('https://smartperfetto.invalid');
      const parsed = new URL(candidate, base);
      if (parsed.origin !== base.origin) return undefined;
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      return undefined;
    }
  }
  try {
    const parsed = new URL(candidate);
    if (
      !['http:', 'https:'].includes(parsed.protocol)
      || parsed.username
      || parsed.password
      || !allowedOrigins.has(parsed.origin)
    ) {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

export class EnterpriseSsoService {
  private static instance: EnterpriseSsoService | undefined;

  constructor(private readonly db: Database.Database = openEnterpriseDb()) {}

  static getInstance(): EnterpriseSsoService {
    if (!EnterpriseSsoService.instance) {
      EnterpriseSsoService.instance = new EnterpriseSsoService();
    }
    return EnterpriseSsoService.instance;
  }

  static resetForTests(): void {
    EnterpriseSsoService.instance = undefined;
  }

  static setInstanceForTests(service: EnterpriseSsoService): void {
    EnterpriseSsoService.instance = service;
  }

  get sessionCookieName(): string {
    return SESSION_COOKIE_NAME;
  }

  get stateCookieName(): string {
    return STATE_COOKIE_NAME;
  }

  createStatePayload(
    returnTo?: string,
    allowedOrigins: ReadonlySet<string> = new Set(),
  ): OidcStatePayload {
    return {
      state: crypto.randomBytes(24).toString('base64url'),
      nonce: crypto.randomBytes(24).toString('base64url'),
      returnTo: normalizeOidcReturnTo(returnTo, allowedOrigins),
      createdAt: nowMs(),
    };
  }

  signStatePayload(payload: OidcStatePayload): string {
    return this.signJson(payload);
  }

  verifyStatePayload(signedValue: string | undefined): OidcStatePayload | null {
    if (!signedValue) return null;
    const parsed = this.verifyJson<OidcStatePayload>(signedValue);
    if (!parsed || !parsed.state || !parsed.nonce || !parsed.codeVerifier) {
      return null;
    }
    if (nowMs() - parsed.createdAt > 10 * 60 * 1000) return null;
    return parsed;
  }

  createSessionCookieValue(accessToken: string): string {
    return accessToken;
  }

  resolveRequestIdentityFromRequest(req: Request): RequestSsoIdentity | null {
    const token = this.extractSessionToken(req);
    if (!token) return null;
    const storedSession = this.getSessionFromToken(token);
    const session = storedSession
      ? this.reconcileSessionAuthorization(storedSession)
      : null;
    if (!session || !session.selectedWorkspaceId) return null;
    return {
      userId: session.userId,
      email: session.authContext.email || '',
      subscription: 'enterprise',
      authType: 'sso',
      tenantId: session.tenantId,
      workspaceId: session.selectedWorkspaceId,
      roles: session.authContext.roles,
      scopes: session.authContext.scopes,
    };
  }

  hasSessionCredential(req: Request): boolean {
    return Boolean(this.extractSessionToken(req));
  }

  getOnboardingSessionFromRequest(req: Request): StoredSsoSession | null {
    const token = this.extractSessionToken(req);
    const session = token ? this.getSessionFromToken(token) : null;
    return session ? this.reconcileSessionAuthorization(session) : null;
  }

  getSessionSummaryFromRequest(req: Request): EnterpriseSsoSessionSummary | null {
    const session = this.getOnboardingSessionFromRequest(req);
    if (!session) return null;
    const workspaces = this.listMemberships(session.tenantId, session.userId);
    const status: EnterpriseSsoSessionSummary['status'] = session.selectedWorkspaceId
      ? 'ready'
      : workspaces.length > 0
        ? 'needs_workspace_selection'
        : 'no_workspace_membership';
    return {
      authenticated: true,
      status,
      tenantId: session.tenantId,
      userId: session.userId,
      workspaceId: session.selectedWorkspaceId,
      email: session.authContext.email,
      displayName: session.authContext.displayName,
      roles: session.authContext.roles,
      scopes: session.authContext.scopes,
      workspaces,
      expiresAt: session.expiresAt,
    };
  }

  completeOidcLogin(userInfo: EnterpriseOidcUserInfo): OnboardingResult {
    const tenantId = this.resolveTenantId(userInfo);
    if (!tenantId) {
      return {
        status: 'needs_tenant_join',
        reason: 'No tenant claim, domain mapping, or default tenant matched this SSO identity',
      };
    }

    const createdUser = this.upsertTenantAndUser(tenantId, userInfo);
    const userId = this.userIdFor(userInfo);
    if (createdUser) {
      this.recordAudit({
        tenantId,
        actorUserId: userId,
        action: 'user_created',
        resourceType: 'user',
        resourceId: userId,
        metadata: { source: 'oidc', issuer: userInfo.issuer },
      });
    }

    const memberships = this.listMemberships(tenantId, userId);
    const selectedWorkspace = this.resolveSelectedWorkspace(userInfo, memberships);
    const roles = selectedWorkspace
      ? [selectedWorkspace.role]
      : ['analyst'];
    const scopes = [...new Set(roles.flatMap(scopesForRole))];
    const session = this.createSsoSession({
      tenantId,
      userId,
      selectedWorkspaceId: selectedWorkspace?.workspaceId,
      roles,
      scopes,
      email: userInfo.email,
      displayName: userInfo.displayName,
    });

    this.recordAudit({
      tenantId,
      workspaceId: selectedWorkspace?.workspaceId,
      actorUserId: userId,
      action: 'sso_login',
      resourceType: 'sso_session',
      resourceId: session.sessionId,
      metadata: { issuer: userInfo.issuer, subjectHash: this.subjectHash(userInfo) },
    });

    if (!selectedWorkspace && memberships.length === 0) {
      return {
        status: 'no_workspace_membership',
        accessToken: session.accessToken,
        sessionId: session.sessionId,
        tenantId,
        userId,
        expiresAt: session.expiresAt,
        workspaces: [],
      };
    }
    if (!selectedWorkspace) {
      return {
        status: 'needs_workspace_selection',
        accessToken: session.accessToken,
        sessionId: session.sessionId,
        tenantId,
        userId,
        expiresAt: session.expiresAt,
        workspaces: memberships,
      };
    }

    this.auditWorkspaceReady(tenantId, userId, selectedWorkspace.workspaceId, session.sessionId, true);
    return {
      status: 'ready',
      accessToken: session.accessToken,
      sessionId: session.sessionId,
      tenantId,
      userId,
      workspaceId: selectedWorkspace.workspaceId,
      expiresAt: session.expiresAt,
      workspaces: memberships,
    };
  }

  selectWorkspace(accessToken: string, workspaceIdInput: string): OnboardingResult {
    const workspaceId = sanitizeId(workspaceIdInput);
    const session = this.getSessionFromToken(accessToken);
    if (!session) {
      return { status: 'needs_tenant_join', reason: 'SSO session is missing or expired' };
    }
    const membership = this.listMemberships(session.tenantId, session.userId)
      .find(item => item.workspaceId === workspaceId);
    if (!membership) {
      return {
        status: 'needs_workspace_selection',
        accessToken,
        sessionId: session.id,
        tenantId: session.tenantId,
        userId: session.userId,
        expiresAt: session.expiresAt,
        workspaces: this.listMemberships(session.tenantId, session.userId),
        reason: 'Selected workspace is not available to this user',
      };
    }

    const roles = [membership.role];
    const scopes = scopesForRole(membership.role);
    this.db.prepare(`
      UPDATE sso_sessions
      SET selected_workspace_id = ?, workspace_id = ?, auth_context_json = ?
      WHERE id = ?
    `).run(
      workspaceId,
      workspaceId,
      JSON.stringify({ ...session.authContext, roles, scopes }),
      session.id,
    );
    this.auditWorkspaceReady(session.tenantId, session.userId, workspaceId, session.id, false);
    return {
      status: 'ready',
      accessToken,
      sessionId: session.id,
      tenantId: session.tenantId,
      userId: session.userId,
      workspaceId,
      expiresAt: session.expiresAt,
      workspaces: this.listMemberships(session.tenantId, session.userId),
    };
  }

  revokeSession(accessToken: string): boolean {
    const sessionId = this.sessionIdFromToken(accessToken);
    if (!sessionId) return false;
    const result = this.db.prepare(`
      UPDATE sso_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL
    `).run(nowMs(), sessionId);
    return result.changes > 0;
  }

  listAuditEvents(): EnterpriseAuditRow[] {
    return listEnterpriseAuditEvents(this.db);
  }

  private extractSessionToken(req: Request): string | undefined {
    const bearer = bearerTokenFromRequest(req);
    if (bearer?.startsWith(SESSION_TOKEN_PREFIX)) return bearer;
    const cookieToken = parseCookieHeader(req.headers.cookie).get(SESSION_COOKIE_NAME);
    return cookieToken?.startsWith(SESSION_TOKEN_PREFIX) ? cookieToken : undefined;
  }

  private createSsoSession(input: {
    tenantId: string;
    userId: string;
    selectedWorkspaceId?: string;
    roles: string[];
    scopes: string[];
    email?: string;
    displayName?: string;
  }): { sessionId: string; accessToken: string; expiresAt: number } {
    const sessionId = crypto.randomUUID();
    const createdAt = nowMs();
    const expiresAt = createdAt + this.sessionTtlMs();
    this.db.prepare(`
      INSERT INTO sso_sessions
        (id, tenant_id, workspace_id, user_id, selected_workspace_id, auth_context_json, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sessionId,
      input.tenantId,
      input.selectedWorkspaceId ?? null,
      input.userId,
      input.selectedWorkspaceId ?? null,
      JSON.stringify({
        authType: 'sso',
        roles: input.roles,
        scopes: input.scopes,
        email: input.email,
        displayName: input.displayName,
      }),
      createdAt,
      expiresAt,
    );
    return {
      sessionId,
      accessToken: this.signSessionId(sessionId),
      expiresAt,
    };
  }

  private getSessionFromToken(accessToken: string): StoredSsoSession | null {
    const sessionId = this.sessionIdFromToken(accessToken);
    if (!sessionId) return null;
    const row = this.db.prepare<unknown[], {
      id: string;
      tenant_id: string;
      workspace_id: string | null;
      user_id: string;
      selected_workspace_id: string | null;
      auth_context_json: string;
      created_at: number;
      expires_at: number;
      revoked_at: number | null;
    }>(`
      SELECT * FROM sso_sessions WHERE id = ?
    `).get(sessionId);
    if (!row || row.revoked_at || row.expires_at <= nowMs()) return null;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id ?? undefined,
      userId: row.user_id,
      selectedWorkspaceId: row.selected_workspace_id ?? undefined,
      authContext: JSON.parse(row.auth_context_json),
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at ?? undefined,
    };
  }

  private sessionIdFromToken(accessToken: string): string | null {
    if (!accessToken.startsWith(SESSION_TOKEN_PREFIX)) return null;
    const signed = accessToken.slice(SESSION_TOKEN_PREFIX.length);
    const separator = signed.lastIndexOf('.');
    if (separator <= 0) return null;
    const sessionId = signed.slice(0, separator);
    const signature = signed.slice(separator + 1);
    const expected = hmac(sessionId, this.cookieSecret());
    if (signature.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    return sessionId;
  }

  private signSessionId(sessionId: string): string {
    return `${SESSION_TOKEN_PREFIX}${sessionId}.${hmac(sessionId, this.cookieSecret())}`;
  }

  private signJson(payload: object): string {
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${encoded}.${hmac(encoded, this.cookieSecret())}`;
  }

  private verifyJson<T>(signedValue: string): T | null {
    const separator = signedValue.lastIndexOf('.');
    if (separator <= 0) return null;
    const encoded = signedValue.slice(0, separator);
    const signature = signedValue.slice(separator + 1);
    const expected = hmac(encoded, this.cookieSecret());
    if (signature.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    try {
      return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T;
    } catch {
      return null;
    }
  }

  private cookieSecret(): string {
    const configured = process.env.SMARTPERFETTO_SSO_COOKIE_SECRET
      || process.env.SMARTPERFETTO_API_KEY;
    if (configured && configured.length >= 16) return configured;
    if (resolveFeatureConfig(process.env).enterprise) {
      throw new Error('SMARTPERFETTO_SSO_COOKIE_SECRET must be set for enterprise SSO');
    }
    return 'dev-only-smartperfetto-sso-cookie-secret';
  }

  private sessionTtlMs(): number {
    const parsed = Number.parseInt(process.env.SMARTPERFETTO_SSO_SESSION_TTL_MS || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SESSION_TTL_MS;
  }

  private resolveTenantId(userInfo: EnterpriseOidcUserInfo): string | null {
    const claimTenant = sanitizeId(claimString(userInfo, [
      'smartperfetto_tenant_id',
      'tenant_id',
      'https://smartperfetto.dev/tenant_id',
    ]));
    if (claimTenant) return claimTenant;

    // EnterpriseOidcClient deliberately suppresses an unverified email.
    // Never fall back to the raw claim here or domain mapping would bypass
    // SMARTPERFETTO_OIDC_REQUIRE_VERIFIED_EMAIL.
    const email = userInfo.email;
    const domain = email?.split('@')[1]?.toLowerCase();
    if (domain) {
      const mappedTenant = parseDomainTenantMap(process.env.SMARTPERFETTO_OIDC_EMAIL_DOMAIN_MAP).get(domain);
      if (mappedTenant) return mappedTenant;
    }

    const defaultTenant = sanitizeId(process.env.SMARTPERFETTO_OIDC_DEFAULT_TENANT_ID);
    return defaultTenant || null;
  }

  private userIdFor(userInfo: EnterpriseOidcUserInfo): string {
    const hash = crypto
      .createHash('sha256')
      .update(`${userInfo.issuer}|${userInfo.subject}`)
      .digest('hex')
      .slice(0, 20);
    return `sso-${hash}`;
  }

  private subjectHash(userInfo: EnterpriseOidcUserInfo): string {
    return crypto
      .createHash('sha256')
      .update(`${userInfo.issuer}|${userInfo.subject}`)
      .digest('hex')
      .slice(0, 12);
  }

  private upsertTenantAndUser(tenantId: string, userInfo: EnterpriseOidcUserInfo): boolean {
    const existing = this.db.prepare('SELECT id FROM users WHERE id = ?').get(this.userIdFor(userInfo));
    const now = nowMs();
    this.db.prepare(`
      INSERT OR IGNORE INTO organizations (id, name, status, plan, created_at, updated_at)
      VALUES (?, ?, 'active', 'enterprise', ?, ?)
    `).run(tenantId, tenantId, now, now);
    this.db.prepare(`
      INSERT INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email = excluded.email,
        display_name = excluded.display_name,
        idp_subject = excluded.idp_subject,
        updated_at = excluded.updated_at
    `).run(
      this.userIdFor(userInfo),
      tenantId,
      userInfo.email || `${this.userIdFor(userInfo)}@sso.local`,
      userInfo.displayName || userInfo.email || this.userIdFor(userInfo),
      `${userInfo.issuer}|${userInfo.subject}`,
      now,
      now,
    );
    return !existing;
  }

  private listMemberships(tenantId: string, userId: string): WorkspaceMembership[] {
    return this.db.prepare<unknown[], {
      workspace_id: string;
      name: string;
      role: string;
    }>(`
      SELECT m.workspace_id, w.name, m.role
      FROM memberships m
      JOIN workspaces w ON w.id = m.workspace_id AND w.tenant_id = m.tenant_id
      WHERE m.tenant_id = ? AND m.user_id = ?
      ORDER BY w.name ASC
    `).all(tenantId, userId).map(row => ({
      workspaceId: row.workspace_id,
      name: row.name,
      role: row.role,
    }));
  }

  private resolveSelectedWorkspace(
    userInfo: EnterpriseOidcUserInfo,
    memberships: WorkspaceMembership[],
  ): WorkspaceMembership | null {
    const claimWorkspace = sanitizeId(claimString(userInfo, [
      'smartperfetto_workspace_id',
      'workspace_id',
      'https://smartperfetto.dev/workspace_id',
    ]));
    if (claimWorkspace) {
      return memberships.find(item => item.workspaceId === claimWorkspace) || null;
    }
    return memberships.length === 1 ? memberships[0] : null;
  }

  private reconcileSessionAuthorization(
    session: StoredSsoSession,
  ): StoredSsoSession {
    if (!session.selectedWorkspaceId) return session;

    const membership = this.db.prepare<unknown[], { role: string }>(`
      SELECT role
      FROM memberships
      WHERE tenant_id = ? AND workspace_id = ? AND user_id = ?
    `).get(
      session.tenantId,
      session.selectedWorkspaceId,
      session.userId,
    );
    if (!membership) {
      const authContext = {
        ...session.authContext,
        roles: [],
        scopes: [],
      };
      this.db.prepare(`
        UPDATE sso_sessions
        SET selected_workspace_id = NULL, workspace_id = NULL, auth_context_json = ?
        WHERE id = ?
      `).run(JSON.stringify(authContext), session.id);
      return {
        ...session,
        workspaceId: undefined,
        selectedWorkspaceId: undefined,
        authContext,
      };
    }

    const roles = [membership.role];
    const scopes = scopesForRole(membership.role);
    if (
      session.authContext.roles.join('\u0000') === roles.join('\u0000')
      && session.authContext.scopes.join('\u0000') === scopes.join('\u0000')
    ) {
      return session;
    }
    const authContext = {
      ...session.authContext,
      roles,
      scopes,
    };
    this.db.prepare(`
      UPDATE sso_sessions
      SET auth_context_json = ?
      WHERE id = ?
    `).run(JSON.stringify(authContext), session.id);
    return {
      ...session,
      authContext,
    };
  }

  private auditWorkspaceReady(
    tenantId: string,
    userId: string,
    workspaceId: string,
    sessionId: string,
    automatic: boolean,
  ): void {
    this.recordAudit({
      tenantId,
      workspaceId,
      actorUserId: userId,
      action: 'workspace_selected',
      resourceType: 'workspace',
      resourceId: workspaceId,
      metadata: { automatic },
    });
    this.recordAudit({
      tenantId,
      workspaceId,
      actorUserId: userId,
      action: 'provider_default_resolved',
      resourceType: 'provider',
      resourceId: 'default',
      metadata: { sessionId },
    });
  }

  private recordAudit(input: EnterpriseAuditInput): void {
    recordEnterpriseAuditEvent(this.db, input);
  }
}

export const enterpriseSsoCookies = {
  session: SESSION_COOKIE_NAME,
  state: STATE_COOKIE_NAME,
};
