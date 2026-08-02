// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import type { Request } from 'express';
import type Database from 'better-sqlite3';
import { resolveAuthConfig } from '../config';
import type { RequestContextAuthType } from '../middleware/auth';
import {deriveServerSecret} from '../security/serverSecret';
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
const PERSONAL_WORKSPACE_NAME = 'Personal Workspace';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_COOKIE_SAME_SITE = 'lax' as const;

interface WorkspaceMembership {
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
  codeVerifier: string;
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
  /** Internal bearer value used to set the HttpOnly cookie; never serialize it. */
  accessToken?: string;
  sessionId?: string;
  tenantId?: string;
  userId?: string;
  workspaceId?: string;
  expiresAt?: number;
  workspaces?: WorkspaceMembership[];
  reason?: string;
  user?: {
    id: string;
    email: string;
    displayName?: string;
  };
  tenant?: {
    id: string;
    name: string;
  };
  workspace?: {
    id: string;
    name: string;
    kind: 'personal';
  };
  roles?: string[];
  scopes?: string[];
  csrfToken?: string;
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

function hmac(value: string, secret: string | Buffer): string {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function safeEqualStrings(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index <= 0) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (!name) continue;
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      // Ignore malformed cookie values instead of turning authentication into a 500.
    }
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

function scopesForRole(role: string): string[] {
  if (role === 'org_admin') return ['*'];
  if (role === 'workspace_admin' || role === 'personal_workspace_owner') {
    return [
      'trace:read',
      'trace:write',
      'agent:run',
      'report:read',
      'analysis_result:read',
      'analysis_result:create',
      'comparison:create',
      'comparison:read',
      'codebase:read',
      'provider:manage_workspace',
    ];
  }
  if (role === 'tenant_admin') return ['tenant:metadata'];
  if (role === 'viewer') return ['trace:read', 'report:read'];
  return ['trace:read', 'trace:write', 'agent:run', 'report:read'];
}

export function normalizeOidcReturnTo(value: unknown): string | undefined {
  const candidate = safeString(value);
  if (!candidate || !candidate.startsWith('/') || candidate.startsWith('//')) {
    return undefined;
  }
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

  get authMode(): ReturnType<typeof resolveAuthConfig>['mode'] {
    return resolveAuthConfig(process.env).mode;
  }

  get sessionTtlMsValue(): number {
    return SESSION_TTL_MS;
  }

  get sessionCookieMaxAgeSeconds(): number {
    return Math.max(1, Math.floor(this.sessionTtlMsValue / 1000));
  }

  get sessionCookieSecure(): boolean {
    return resolveAuthConfig(process.env).cookieSecure;
  }

  get sessionCookieSameSite(): 'lax' | 'strict' | 'none' {
    return SESSION_COOKIE_SAME_SITE;
  }

  createStatePayload(returnTo?: string): OidcStatePayload {
    return {
      state: crypto.randomBytes(24).toString('base64url'),
      nonce: crypto.randomBytes(24).toString('base64url'),
      codeVerifier: crypto.randomBytes(32).toString('base64url'),
      returnTo: normalizeOidcReturnTo(returnTo),
      createdAt: nowMs(),
    };
  }

  signStatePayload(payload: OidcStatePayload): string {
    return this.signJson(payload);
  }

  verifyStatePayload(signedValue: string | undefined): OidcStatePayload | null {
    if (!signedValue) return null;
    const parsed = this.verifyJson<OidcStatePayload>(signedValue);
    if (!parsed || !parsed.state || !parsed.nonce || !parsed.codeVerifier) return null;
    if (nowMs() - parsed.createdAt > 10 * 60 * 1000) return null;
    return parsed;
  }

  createSessionCookieValue(accessToken: string): string {
    return accessToken;
  }

  csrfTokenForRequest(req: Request): string | null {
    const token = this.extractSessionToken(req);
    return token ? this.csrfTokenForSessionToken(token) : null;
  }

  verifyCsrfTokenForRequest(req: Request, token: string | undefined): boolean {
    const expected = this.csrfTokenForRequest(req);
    if (!expected || !token) return false;
    return safeEqualStrings(expected, token);
  }

  isCookieAuthenticatedRequest(req: Request): boolean {
    const cookieToken = parseCookieHeader(req.headers.cookie).get(SESSION_COOKIE_NAME);
    return Boolean(cookieToken?.startsWith(SESSION_TOKEN_PREFIX));
  }

  private csrfTokenForSessionToken(accessToken: string): string | null {
    const sessionId = this.sessionIdFromToken(accessToken);
    if (!sessionId || !this.getSessionFromToken(accessToken)) return null;
    return hmac(`csrf:${sessionId}`, this.cookieSecret());
  }

  private authoritativeRoles(session: StoredSsoSession): string[] | null {
    let roles: string[];
    if (this.isPersonalWorkspaceMode()) {
      if (!session.selectedWorkspaceId || !this.db.prepare<unknown[], { workspace_id: string }>(`
        SELECT workspace_id
        FROM sso_personal_workspaces
        WHERE tenant_id = ? AND user_id = ? AND workspace_id = ?
        LIMIT 1
      `).get(session.tenantId, session.userId, session.selectedWorkspaceId)) {
        return null;
      }
      roles = ['personal_workspace_owner'];
    } else {
      const membership = session.selectedWorkspaceId
        ? this.db.prepare<unknown[], { role: string }>(`
            SELECT role FROM memberships
            WHERE tenant_id = ? AND workspace_id = ? AND user_id = ?
            LIMIT 1
          `).get(session.tenantId, session.selectedWorkspaceId, session.userId)
        : undefined;
      if (!membership) return null;
      roles = [membership.role];
    }
    if (this.hasTenantAdminGrant(session.tenantId, session.userId)) roles.push('tenant_admin');
    return [...new Set(roles.length > 0 ? roles : ['analyst'])];
  }

  private hasTenantAdminGrant(tenantId: string, userId: string): boolean {
    return Boolean(this.db.prepare<unknown[], { user_id: string }>(`
      SELECT user_id FROM sso_tenant_admin_grants
      WHERE tenant_id = ? AND user_id = ?
      LIMIT 1
    `).get(tenantId, userId));
  }

  resolveRequestIdentityFromRequest(req: Request): RequestSsoIdentity | null {
    const token = this.extractSessionToken(req);
    if (!token) return null;
    const session = this.getSessionFromToken(token);
    if (!session || !session.selectedWorkspaceId) return null;
    const roles = this.authoritativeRoles(session);
    if (!roles) return null;
    return {
      userId: session.userId,
      email: session.authContext.email || '',
      subscription: 'enterprise',
      authType: 'sso',
      tenantId: session.tenantId,
      workspaceId: session.selectedWorkspaceId,
      roles,
      scopes: [...new Set(roles.flatMap(scopesForRole))],
    };
  }

  hasSessionCredential(req: Request): boolean {
    return Boolean(this.extractSessionToken(req));
  }

  getOnboardingSessionFromRequest(req: Request): StoredSsoSession | null {
    const token = this.extractSessionToken(req);
    return token ? this.getSessionFromToken(token) : null;
  }

  getSessionView(req: Request): Record<string, unknown> {
    const token = this.extractSessionToken(req);
    const session = token ? this.getSessionFromToken(token) : null;
    const authMode = this.authMode;
    const authContract = {
      authMode,
      loginUrl: authMode === 'oidc' ? '/api/auth/oidc/login' : null,
      workspaceMode: authMode === 'oidc' ? 'personal_single' : 'managed',
      managedIdentity: authMode === 'oidc',
    };
    if (!session) {
      return {
        success: true,
        authenticated: false,
        ...authContract,
        status: 'unauthenticated',
      };
    }

    const roles = session.selectedWorkspaceId
      ? this.authoritativeRoles(session)
      : [...(session.authContext.roles || ['analyst'])];
    if (!roles) {
      return {
        success: true,
        authenticated: false,
        ...authContract,
        status: 'unauthenticated',
      };
    }
    const user = this.db.prepare<unknown[], {
      email: string;
      display_name: string | null;
    }>(`
      SELECT email, display_name FROM users WHERE id = ? AND tenant_id = ? LIMIT 1
    `).get(session.userId, session.tenantId);
    const tenant = this.db.prepare<unknown[], { id: string; name: string }>(`
      SELECT id, name FROM organizations WHERE id = ? LIMIT 1
    `).get(session.tenantId);
    const workspace = session.selectedWorkspaceId
      ? this.db.prepare<unknown[], { id: string; name: string }>(`
          SELECT id, name FROM workspaces WHERE tenant_id = ? AND id = ? LIMIT 1
        `).get(session.tenantId, session.selectedWorkspaceId)
      : undefined;
    const workspaces = this.isPersonalWorkspaceMode() && workspace
      ? [{ workspaceId: workspace.id, name: workspace.name, role: 'personal_workspace_owner' }]
      : this.listMemberships(session.tenantId, session.userId);
    const status = workspace
      ? 'ready'
      : workspaces.length > 0 ? 'needs_workspace_selection' : 'no_workspace_membership';

    return {
      success: true,
      authenticated: true,
      ...authContract,
      status,
      user: {
        id: session.userId,
        email: user?.email || session.authContext.email || '',
        ...(user?.display_name || session.authContext.displayName
          ? { displayName: user?.display_name || session.authContext.displayName }
          : {}),
      },
      tenant: {
        id: session.tenantId,
        name: tenant?.name || session.tenantId,
      },
      workspace: workspace ? {
        id: workspace.id,
        name: workspace.name,
        kind: this.isPersonalWorkspaceMode() ? 'personal' : 'managed',
      } : null,
      workspaces,
      roles,
      scopes: [...new Set(roles.flatMap(scopesForRole))],
      expiresAt: session.expiresAt,
      csrfToken: token ? this.csrfTokenForSessionToken(token) : null,
      tenantId: session.tenantId,
      userId: session.userId,
      workspaceId: workspace?.id,
    };
  }

  completeOidcLogin(userInfo: EnterpriseOidcUserInfo): OnboardingResult {
    const tenantId = this.resolveTenantId(userInfo);
    if (!tenantId) {
      return {
        status: 'needs_tenant_join',
        reason: 'OIDC identity did not include a valid issuer',
      };
    }

    const userId = this.userIdFor(userInfo);
    const transaction = this.db.transaction(() => {
      const createdUser = this.upsertTenantAndUser(tenantId, userInfo);
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

      const isTenantAdmin = this.hasTenantAdminGrant(tenantId, userId);
      const memberships = this.listMemberships(tenantId, userId);
      const personalMode = this.isPersonalWorkspaceMode();
      const selectedWorkspace = personalMode
        ? this.ensurePersonalWorkspace(tenantId, userId, userInfo)
        : this.resolveSelectedWorkspace(userInfo, memberships);
      const baseRoles = personalMode
        ? (selectedWorkspace ? ['personal_workspace_owner'] : [])
        : (selectedWorkspace ? [selectedWorkspace.role] : []);
      const roles = [
        ...baseRoles,
        ...(isTenantAdmin ? ['tenant_admin'] : []),
      ];
      const effectiveRoles = roles.length > 0 ? roles : ['analyst'];
      const scopes = [...new Set(effectiveRoles.flatMap(scopesForRole))];
      const session = this.createSsoSession({
        tenantId,
        userId,
        selectedWorkspaceId: selectedWorkspace?.workspaceId,
        roles: effectiveRoles,
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
          status: 'no_workspace_membership' as const,
          accessToken: session.accessToken,
          sessionId: session.sessionId,
          tenantId,
          userId,
          expiresAt: session.expiresAt,
          workspaces: [],
          roles: effectiveRoles,
          scopes,
          csrfToken: this.csrfTokenForSessionToken(session.accessToken) || undefined,
        };
      }
      if (!selectedWorkspace) {
        return {
          status: 'needs_workspace_selection' as const,
          accessToken: session.accessToken,
          sessionId: session.sessionId,
          tenantId,
          userId,
          expiresAt: session.expiresAt,
          workspaces: memberships,
          roles: effectiveRoles,
          scopes,
          csrfToken: this.csrfTokenForSessionToken(session.accessToken) || undefined,
        };
      }

      this.auditWorkspaceReady(tenantId, userId, selectedWorkspace.workspaceId, session.sessionId, true);
      return {
        status: 'ready' as const,
        accessToken: session.accessToken,
        sessionId: session.sessionId,
        tenantId,
        userId,
        workspaceId: selectedWorkspace.workspaceId,
        expiresAt: session.expiresAt,
        workspaces: [selectedWorkspace],
        roles: effectiveRoles,
        scopes,
        csrfToken: this.csrfTokenForSessionToken(session.accessToken) || undefined,
        user: {
          id: userId,
          email: userInfo.email || `${userId}@sso.local`,
          ...(userInfo.displayName ? { displayName: userInfo.displayName } : {}),
        },
        tenant: { id: tenantId, name: tenantId },
        workspace: {
          id: selectedWorkspace.workspaceId,
          name: selectedWorkspace.name,
          kind: 'personal' as const,
        },
      };
    });
    return transaction();
  }

  selectWorkspace(accessToken: string, workspaceIdInput: string): OnboardingResult {
    const session = this.getSessionFromToken(accessToken);
    if (!session) {
      return { status: 'needs_tenant_join', reason: 'SSO session is missing or expired' };
    }
    if (this.isPersonalWorkspaceMode()) {
      return {
        status: 'ready',
        accessToken,
        sessionId: session.id,
        tenantId: session.tenantId,
        userId: session.userId,
        workspaceId: session.selectedWorkspaceId,
        expiresAt: session.expiresAt,
        reason: 'OIDC personal workspace is assigned by the server and cannot be changed',
      };
    }
    const workspaceId = sanitizeId(workspaceIdInput);
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

    const roles = [
      membership.role,
      ...(this.hasTenantAdminGrant(session.tenantId, session.userId) ? ['tenant_admin'] : []),
    ];
    const scopes = [...new Set(roles.flatMap(scopesForRole))];
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

  private cookieSecret(): Buffer {
    return deriveServerSecret({purpose: 'browser-session', minimumBytes: 16});
  }

  private sessionTtlMs(): number {
    return SESSION_TTL_MS;
  }

  private isPersonalWorkspaceMode(): boolean {
    return resolveAuthConfig(process.env).oidcEnabled;
  }

  private ensurePersonalWorkspace(
    tenantId: string,
    userId: string,
    userInfo: EnterpriseOidcUserInfo,
  ): WorkspaceMembership {
    const existing = this.db.prepare<unknown[], {
      workspace_id: string;
      name: string;
    }>(`
      SELECT p.workspace_id, w.name
      FROM sso_personal_workspaces p
      JOIN workspaces w
        ON w.tenant_id = p.tenant_id AND w.id = p.workspace_id
      WHERE p.tenant_id = ? AND p.user_id = ?
      LIMIT 1
    `).get(tenantId, userId);
    if (existing) {
      this.db.prepare(`
        INSERT INTO memberships(tenant_id, workspace_id, user_id, role, created_at)
        VALUES (?, ?, ?, 'workspace_admin', ?)
        ON CONFLICT(tenant_id, workspace_id, user_id) DO UPDATE SET role = 'workspace_admin'
      `).run(tenantId, existing.workspace_id, userId, nowMs());
      return { workspaceId: existing.workspace_id, name: existing.name, role: 'workspace_admin' };
    }

    let workspaceId = `sso-personal-${userId}`;
    const now = nowMs();
    const workspaceInsert = this.db.prepare(`
      INSERT INTO workspaces
        (id, tenant_id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(workspaceId, tenantId, PERSONAL_WORKSPACE_NAME, now, now);
    if (workspaceInsert.changes === 0) {
      workspaceId = `sso-personal-${crypto.randomUUID()}`;
      this.db.prepare(`
        INSERT INTO workspaces
          (id, tenant_id, name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(workspaceId, tenantId, PERSONAL_WORKSPACE_NAME, now, now);
    }
    const mappingInsert = this.db.prepare(`
      INSERT INTO sso_personal_workspaces(tenant_id, user_id, workspace_id, created_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(tenant_id, user_id) DO NOTHING
    `).run(tenantId, userId, workspaceId, now);
    const selectedWorkspace = this.db.prepare<unknown[], {
      workspace_id: string;
      name: string;
    }>(`
      SELECT p.workspace_id, w.name
      FROM sso_personal_workspaces p
      JOIN workspaces w
        ON w.tenant_id = p.tenant_id AND w.id = p.workspace_id
      WHERE p.tenant_id = ? AND p.user_id = ?
      LIMIT 1
    `).get(tenantId, userId);
    if (!selectedWorkspace) {
      throw new Error('Failed to create the OIDC personal workspace');
    }
    this.db.prepare(`
      INSERT INTO memberships(tenant_id, workspace_id, user_id, role, created_at)
      VALUES (?, ?, ?, 'workspace_admin', ?)
      ON CONFLICT(tenant_id, workspace_id, user_id) DO UPDATE SET role = 'workspace_admin'
    `).run(tenantId, selectedWorkspace.workspace_id, userId, now);
    if (mappingInsert.changes > 0) {
      this.recordAudit({
        tenantId,
        workspaceId: selectedWorkspace.workspace_id,
        actorUserId: userId,
        action: 'personal_workspace_created',
        resourceType: 'workspace',
        resourceId: selectedWorkspace.workspace_id,
        metadata: {
          source: 'oidc',
          issuer: userInfo.issuer,
        },
      });
    }
    return {
      workspaceId: selectedWorkspace.workspace_id,
      name: selectedWorkspace.name,
      role: 'workspace_admin',
    };
  }

  private resolveTenantId(userInfo: EnterpriseOidcUserInfo): string | null {
    if (!resolveAuthConfig(process.env).oidcEnabled) {
      const claimTenant = sanitizeId(claimString(userInfo, [
        'smartperfetto_tenant_id',
        'tenant_id',
        'https://smartperfetto.dev/tenant_id',
      ]));
      if (claimTenant) return claimTenant;
    }
    const issuer = safeString(userInfo.issuer)?.replace(/\/+$/, '');
    if (!issuer) return null;
    const issuerHash = crypto.createHash('sha256').update(issuer).digest('hex').slice(0, 32);
    return `oidc-${issuerHash}`;
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
    const userId = this.userIdFor(userInfo);
    const existing = this.db.prepare<unknown[], { id: string; tenant_id: string }>(
      'SELECT id, tenant_id FROM users WHERE id = ?',
    ).get(userId);
    if (existing && existing.tenant_id !== tenantId) {
      throw new Error('OIDC subject is already bound to a different tenant');
    }
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
      userId,
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
