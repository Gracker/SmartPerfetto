// backend/src/services/providerManager/providerStore.ts
// SPDX-License-Identifier: AGPL-3.0-or-later

import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import Database from 'better-sqlite3';
import {resolveAuthConfig} from '../../config';
import { openEnterpriseDb } from '../enterpriseDb';
import {
  enterpriseDbReadAuthorityEnabled,
  enterpriseDbWritesEnabled,
  legacyFilesystemWritesEnabled,
} from '../enterpriseMigration';
import { recordEnterpriseAuditEvent } from '../enterpriseAuditService';
import type { ProviderConfig, ProviderConnection, ProviderScope } from './types';
import { LocalEncryptedSecretStore } from './localSecretStore';
import {
  localProviderMutationScope,
  ProviderMutationGenerationStore,
  providerMutationRequestScopes,
  type ProviderMutationGenerationVectorV1,
  type ProviderMutationLease,
  type ProviderMutationOwner,
  type ProviderMutationScope,
} from './providerMutationGeneration';

type ProviderCredentialScope = 'personal' | 'workspace' | 'org';

interface ProviderCredentialRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  owner_user_id: string | null;
  scope: ProviderCredentialScope;
  name: string;
  type: ProviderConfig['type'];
  models_json: string;
  secret_ref: string;
  policy_json: string | null;
  created_at: number;
  updated_at: number;
}

interface ProviderPolicyJson {
  category?: ProviderConfig['category'];
  isActive?: boolean;
  connection?: ProviderConnection;
  tuning?: ProviderConfig['tuning'];
  custom?: ProviderConfig['custom'];
  secretVersion?: number;
}

interface ResolvedProviderScope {
  tenantId: string;
  workspaceId: string;
  userId: string | null;
}

const DEFAULT_PROVIDER_SCOPE = {
  tenantId: 'default-dev-tenant',
  workspaceId: 'default-workspace',
  userId: 'dev-user-123',
};

const SAFE_PROVIDER_SCOPE_RE = /^[a-zA-Z0-9._:-]+$/;
const SENSITIVE_CONNECTION_FIELDS: Array<keyof ProviderConnection> = [
  'apiKey',
  'claudeApiKey',
  'claudeAuthToken',
  'openaiApiKey',
  'piAgentCoreModelJson',
  'openCodeModelJson',
  'awsBearerToken',
  'awsAccessKeyId',
  'awsSecretAccessKey',
  'awsSessionToken',
];

function enterpriseProviderStoreEnabled(): boolean {
  return enterpriseDbReadAuthorityEnabled();
}

function enterpriseProviderDbWritesEnabled(): boolean {
  return enterpriseDbWritesEnabled();
}

function legacyProviderWritesEnabled(): boolean {
  return legacyFilesystemWritesEnabled();
}

function oidcProviderWriteIsolationEnabled(): boolean {
  return resolveAuthConfig(process.env).oidcEnabled;
}

function assertSafeScopeSegment(value: string, label: string): string {
  if (!SAFE_PROVIDER_SCOPE_RE.test(value) || value === '.' || value === '..') {
    throw new Error(`Unsafe provider ${label}: ${value}`);
  }
  return value;
}

function resolveProviderScope(scope?: ProviderScope): ResolvedProviderScope {
  const rawUserId = scope === undefined ? DEFAULT_PROVIDER_SCOPE.userId : scope.userId;
  return {
    tenantId: assertSafeScopeSegment(scope?.tenantId || DEFAULT_PROVIDER_SCOPE.tenantId, 'tenant id'),
    workspaceId: assertSafeScopeSegment(scope?.workspaceId || DEFAULT_PROVIDER_SCOPE.workspaceId, 'workspace id'),
    userId: rawUserId === undefined || rawUserId === null
      ? null
      : assertSafeScopeSegment(rawUserId, 'user id'),
  };
}

function parseJsonObject(value: string | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function toEpochMs(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function toIsoString(value: number): string {
  return new Date(value).toISOString();
}

function splitConnectionSecrets(connection: ProviderConnection): {
  publicConnection: ProviderConnection;
  secretConnection: Record<string, string>;
} {
  const publicConnection: ProviderConnection = {};
  const secretConnection: Record<string, string> = {};
  for (const [key, value] of Object.entries(connection)) {
    if (value === undefined) continue;
    if (SENSITIVE_CONNECTION_FIELDS.includes(key as keyof ProviderConnection)) {
      if (typeof value === 'string' && value.length > 0) {
        secretConnection[key] = value;
      }
    } else {
      (publicConnection as Record<string, unknown>)[key] = value;
    }
  }
  return { publicConnection, secretConnection };
}

function mergeConnectionSecrets(
  publicConnection: ProviderConnection | undefined,
  secretConnection: Record<string, string>,
): ProviderConnection {
  return {
    ...(publicConnection ?? {}),
    ...secretConnection,
  };
}

const CUSTOM_HEADER_SECRET_PREFIX = 'custom-header:';
const CUSTOM_ENV_SECRET_PREFIX = 'custom-env:';

function splitProviderSecrets(provider: ProviderConfig): {
  publicConnection: ProviderConnection;
  publicCustom: ProviderConfig['custom'];
  secrets: Record<string, string>;
} {
  const {publicConnection, secretConnection} = splitConnectionSecrets(provider.connection);
  const secrets = {...secretConnection};
  for (const [key, value] of Object.entries(provider.custom?.headers ?? {})) {
    secrets[`${CUSTOM_HEADER_SECRET_PREFIX}${encodeURIComponent(key)}`] = value;
  }
  for (const [key, value] of Object.entries(provider.custom?.envOverrides ?? {})) {
    secrets[`${CUSTOM_ENV_SECRET_PREFIX}${encodeURIComponent(key)}`] = value;
  }
  const publicCustom = provider.custom
    ? {
        ...(provider.custom.headers ? {headers: {}} : {}),
        ...(provider.custom.envOverrides ? {envOverrides: {}} : {}),
      }
    : undefined;
  return {publicConnection, publicCustom, secrets};
}

function mergeProviderSecrets(
  publicConnection: ProviderConnection | undefined,
  publicCustom: ProviderConfig['custom'],
  secrets: Record<string, string>,
): {connection: ProviderConnection; custom: ProviderConfig['custom']} {
  const connectionSecrets: Record<string, string> = {};
  const headers = {...(publicCustom?.headers ?? {})};
  const envOverrides = {...(publicCustom?.envOverrides ?? {})};
  for (const [key, value] of Object.entries(secrets)) {
    if (key.startsWith(CUSTOM_HEADER_SECRET_PREFIX)) {
      headers[decodeURIComponent(key.slice(CUSTOM_HEADER_SECRET_PREFIX.length))] = value;
    } else if (key.startsWith(CUSTOM_ENV_SECRET_PREFIX)) {
      envOverrides[decodeURIComponent(key.slice(CUSTOM_ENV_SECRET_PREFIX.length))] = value;
    } else {
      connectionSecrets[key] = value;
    }
  }
  const hasCustom = publicCustom || Object.keys(headers).length > 0 || Object.keys(envOverrides).length > 0;
  return {
    connection: mergeConnectionSecrets(publicConnection, connectionSecrets),
    custom: hasCustom
      ? {
          ...(Object.keys(headers).length > 0 ? {headers} : {}),
          ...(Object.keys(envOverrides).length > 0 ? {envOverrides} : {}),
        }
      : undefined,
  };
}

function providerSecretRef(scope: ResolvedProviderScope, providerId: string): string {
  return `secret:provider:${scope.tenantId}:${scope.workspaceId}:${scope.userId ?? '_workspace'}:${providerId}`;
}

function ensureEnterpriseProviderGraph(scope: ResolvedProviderScope): void {
  const now = Date.now();
  const db = openEnterpriseDb();
  try {
    db.prepare(`
      INSERT OR IGNORE INTO organizations (id, name, status, plan, created_at, updated_at)
      VALUES (?, ?, 'active', 'enterprise', ?, ?)
    `).run(scope.tenantId, scope.tenantId, now, now);
    db.prepare(`
      INSERT OR IGNORE INTO workspaces (id, tenant_id, name, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(scope.workspaceId, scope.tenantId, scope.workspaceId, now, now);
    if (scope.userId) {
      db.prepare(`
        INSERT INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          email = excluded.email,
          display_name = excluded.display_name,
          updated_at = excluded.updated_at
      `).run(
        scope.userId,
        scope.tenantId,
        `${scope.userId}@provider.local`,
        scope.userId,
        `provider:${scope.userId}`,
        now,
        now,
      );
    }
  } finally {
    db.close();
  }
}

function accessibleProviderWhere(): string {
  return `
    tenant_id = @tenantId
    AND (
      (scope = 'personal' AND workspace_id = @workspaceId AND owner_user_id = @userId)
      OR (scope = 'workspace' AND workspace_id = @workspaceId AND owner_user_id IS NULL)
      OR (scope = 'org' AND workspace_id IS NULL AND owner_user_id IS NULL)
    )
  `;
}

function writableProviderWhere(): string {
  return `
    tenant_id = @tenantId
    AND (
      (@userId IS NOT NULL
        AND scope = 'personal'
        AND workspace_id = @workspaceId
        AND owner_user_id = @userId)
      OR (@userId IS NULL
        AND scope = 'workspace'
        AND workspace_id = @workspaceId
        AND owner_user_id IS NULL)
    )
  `;
}

export class ProviderStore {
  private providers = new Map<string, ProviderConfig>();
  private filePath: string;
  private secretStore?: LocalEncryptedSecretStore;
  private readonly mutationGenerations: ProviderMutationGenerationStore;

  constructor(filePath: string) {
    this.filePath = filePath;
    const enterprise = enterpriseProviderStoreEnabled();
    this.mutationGenerations = new ProviderMutationGenerationStore({
      openDatabase: () => {
        if (enterprise) return openEnterpriseDb();
        const databasePath = `${this.filePath}.generations.db`;
        fs.mkdirSync(path.dirname(databasePath), {recursive: true});
        return new Database(databasePath);
      },
      ensureSchema: !enterprise,
    });
  }

  load(): void {
    if (enterpriseProviderStoreEnabled()) return;
    this.providers.clear();
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const arr: ProviderConfig[] = JSON.parse(raw);
      for (const p of arr) this.providers.set(p.id, p);
    } catch (err) {
      console.warn('[ProviderStore] Failed to load providers.json, starting fresh:', (err as Error).message);
    }
  }

  getAll(scope?: ProviderScope): ProviderConfig[] {
    if (enterpriseProviderStoreEnabled()) {
      return this.getAllEnterprise(scope);
    }
    return Array.from(this.providers.values());
  }

  get(id: string, scope?: ProviderScope): ProviderConfig | undefined {
    if (enterpriseProviderStoreEnabled()) {
      return this.getEnterprise(id, scope);
    }
    return this.providers.get(id);
  }

  getActive(scope?: ProviderScope): ProviderConfig | undefined {
    for (const p of this.getAll(scope)) {
      if (p.isActive) return p;
    }
    return undefined;
  }

  getActivePeer(id: string, scope?: ProviderScope): ProviderConfig | undefined {
    if (enterpriseProviderStoreEnabled()) {
      return this.getActiveEnterprisePeer(id, scope);
    }
    return this.getActive(scope);
  }

  getActiveWriteScope(scope?: ProviderScope): ProviderConfig | undefined {
    if (enterpriseProviderStoreEnabled()) {
      return this.getActiveEnterpriseWriteScope(scope);
    }
    return this.getActive(scope);
  }

  set(provider: ProviderConfig, scope?: ProviderScope): void {
    if (!enterpriseProviderStoreEnabled()) {
      this.providers.set(provider.id, provider);
      this.persist();
    }
    if (enterpriseProviderDbWritesEnabled()) {
      this.setEnterprise(provider, scope);
    }
  }

  delete(id: string, scope?: ProviderScope): boolean {
    let deleted = false;
    if (!enterpriseProviderStoreEnabled()) {
      deleted = this.providers.delete(id);
      if (deleted) this.persist();
    }
    if (enterpriseProviderDbWritesEnabled()) {
      deleted = this.deleteEnterprise(id, scope) || deleted;
    }
    return deleted;
  }

  rotateSecret(id: string, scope?: ProviderScope): number | undefined {
    if (!enterpriseProviderDbWritesEnabled()) return undefined;
    return this.rotateEnterpriseSecret(id, scope);
  }

  beginMutationForNewProvider(
    scope: ProviderScope | undefined,
    owner: ProviderMutationOwner,
  ): ProviderMutationLease {
    if (enterpriseProviderStoreEnabled()) {
      ensureEnterpriseProviderGraph(resolveProviderScope(scope));
    }
    return this.mutationGenerations.beginMutation(
      this.newProviderMutationScope(scope),
      owner,
    );
  }

  beginMutationForProvider(
    id: string,
    scope: ProviderScope | undefined,
    owner: ProviderMutationOwner,
  ): ProviderMutationLease {
    return this.mutationGenerations.beginMutation(
      this.existingProviderMutationScope(id, scope),
      owner,
    );
  }

  completeMutation(lease: ProviderMutationLease): void {
    this.mutationGenerations.completeMutation(lease);
  }

  readMutationGeneration(
    scope?: ProviderScope,
  ): ProviderMutationGenerationVectorV1 {
    return this.mutationGenerations.readVector(
      this.requestMutationScopes(scope),
    );
  }

  listInFlightMutations(scope?: ProviderScope): ProviderMutationLease[] {
    return this.mutationGenerations.listInFlight(
      this.requestMutationScopes(scope),
    );
  }

  recoverAbandonedMutation(
    mutationId: string,
    mutationScope: ProviderMutationScope,
  ): boolean {
    return this.mutationGenerations.recoverAbandonedMutation(
      mutationId,
      mutationScope,
    );
  }

  private getSecretStore(): LocalEncryptedSecretStore {
    if (!this.secretStore) {
      this.secretStore = new LocalEncryptedSecretStore();
    }
    return this.secretStore;
  }

  private newProviderMutationScope(
    scope?: ProviderScope,
  ): ProviderMutationScope {
    if (!enterpriseProviderStoreEnabled()) {
      return localProviderMutationScope();
    }
    const resolved = resolveProviderScope(scope);
    return {
      level: resolved.userId ? 'personal' : 'workspace',
      tenantId: resolved.tenantId,
      workspaceId: resolved.workspaceId,
      userId: resolved.userId,
    };
  }

  private existingProviderMutationScope(
    id: string,
    scope?: ProviderScope,
  ): ProviderMutationScope {
    const oidcWriteIsolation = oidcProviderWriteIsolationEnabled();
    if (!enterpriseProviderStoreEnabled()) {
      if (oidcWriteIsolation && enterpriseProviderDbWritesEnabled()) {
        const resolved = resolveProviderScope(scope);
        const existing = this.getEnterpriseRowById(id);
        if (existing && !this.getWritableEnterpriseRowById(id, resolved)) {
          throw new Error(`Provider not found: ${id}`);
        }
      }
      return localProviderMutationScope();
    }
    const resolved = resolveProviderScope(scope);
    const row = oidcWriteIsolation
      ? this.getWritableEnterpriseRowById(id, resolved)
      : this.getAccessibleEnterpriseRowById(id, resolved);
    if (!row) throw new Error(`Provider not found: ${id}`);
    return {
      level: row.scope,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      userId: row.owner_user_id,
    };
  }

  private requestMutationScopes(
    scope?: ProviderScope,
  ): ProviderMutationScope[] {
    if (!enterpriseProviderStoreEnabled()) {
      return [localProviderMutationScope()];
    }
    return providerMutationRequestScopes(resolveProviderScope(scope));
  }

  private getAllEnterprise(scope?: ProviderScope): ProviderConfig[] {
    const resolved = resolveProviderScope(scope);
    const db = openEnterpriseDb();
    try {
      const rows = db.prepare<unknown[], ProviderCredentialRow>(`
        SELECT *
        FROM provider_credentials
        WHERE ${accessibleProviderWhere()}
        ORDER BY
          CASE scope
            WHEN 'personal' THEN 0
            WHEN 'workspace' THEN 1
            ELSE 2
          END,
          updated_at DESC
      `).all(resolved);
      return rows
        .map(row => this.providerFromEnterpriseRow(row))
        .filter((provider): provider is ProviderConfig => Boolean(provider));
    } finally {
      db.close();
    }
  }

  private getEnterprise(id: string, scope?: ProviderScope): ProviderConfig | undefined {
    const resolved = resolveProviderScope(scope);
    const db = openEnterpriseDb();
    try {
      const row = db.prepare<unknown[], ProviderCredentialRow>(`
        SELECT *
        FROM provider_credentials
        WHERE id = @id AND ${accessibleProviderWhere()}
        LIMIT 1
      `).get({ ...resolved, id });
      return row ? this.providerFromEnterpriseRow(row) ?? undefined : undefined;
    } finally {
      db.close();
    }
  }

  private setEnterprise(provider: ProviderConfig, scope?: ProviderScope): void {
    const resolved = resolveProviderScope(scope);
    ensureEnterpriseProviderGraph(resolved);
    const oidcWriteIsolation = oidcProviderWriteIsolationEnabled();
    const existing = oidcWriteIsolation
      ? this.getWritableEnterpriseRowById(provider.id, resolved)
      : this.getAccessibleEnterpriseRowById(provider.id, resolved);
    if (oidcWriteIsolation && !existing && this.getEnterpriseRowById(provider.id)) {
      throw new Error(`Provider not found: ${provider.id}`);
    }
    const effectiveScope = existing?.scope ?? (resolved.userId ? 'personal' : 'workspace');
    const workspaceId = effectiveScope === 'org' ? null : resolved.workspaceId;
    const ownerUserId = effectiveScope === 'personal' ? resolved.userId : null;
    const secretRef = existing?.secret_ref ?? providerSecretRef(resolved, provider.id);
    const {publicConnection, publicCustom, secrets} = splitProviderSecrets(provider);
    const secretVersion = this.getSecretStore().put(secretRef, secrets);
    const policy: ProviderPolicyJson = {
      category: provider.category,
      isActive: provider.isActive,
      connection: publicConnection,
      ...(provider.tuning ? { tuning: provider.tuning } : {}),
      ...(publicCustom ? {custom: publicCustom} : {}),
      secretVersion,
    };

    const db = openEnterpriseDb();
    try {
      if (!oidcWriteIsolation) {
        db.prepare(`
          INSERT INTO provider_credentials
            (id, tenant_id, workspace_id, owner_user_id, scope, name, type, models_json, secret_ref, policy_json, created_at, updated_at)
          VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            tenant_id = excluded.tenant_id,
            workspace_id = excluded.workspace_id,
            owner_user_id = excluded.owner_user_id,
            scope = excluded.scope,
            name = excluded.name,
            type = excluded.type,
            models_json = excluded.models_json,
            secret_ref = excluded.secret_ref,
            policy_json = excluded.policy_json,
            updated_at = excluded.updated_at
        `).run(
          provider.id,
          resolved.tenantId,
          workspaceId,
          ownerUserId,
          effectiveScope,
          provider.name,
          provider.type,
          JSON.stringify(provider.models),
          secretRef,
          JSON.stringify(policy),
          existing?.created_at ?? toEpochMs(provider.createdAt),
          toEpochMs(provider.updatedAt),
        );
      } else if (existing) {
        const result = db.prepare(`
          UPDATE provider_credentials
          SET name = @name,
              type = @type,
              models_json = @modelsJson,
              secret_ref = @secretRef,
              policy_json = @policyJson,
              updated_at = @updatedAt
          WHERE id = @id AND ${writableProviderWhere()}
        `).run({
          ...resolved,
          id: provider.id,
          name: provider.name,
          type: provider.type,
          modelsJson: JSON.stringify(provider.models),
          secretRef,
          policyJson: JSON.stringify(policy),
          updatedAt: toEpochMs(provider.updatedAt),
        });
        if (result.changes !== 1) {
          throw new Error(`Provider not found: ${provider.id}`);
        }
      } else {
        db.prepare(`
          INSERT INTO provider_credentials
            (id, tenant_id, workspace_id, owner_user_id, scope, name, type, models_json, secret_ref, policy_json, created_at, updated_at)
          VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          provider.id,
          resolved.tenantId,
          workspaceId,
          ownerUserId,
          effectiveScope,
          provider.name,
          provider.type,
          JSON.stringify(provider.models),
          secretRef,
          JSON.stringify(policy),
          toEpochMs(provider.createdAt),
          toEpochMs(provider.updatedAt),
        );
      }
      this.recordProviderSecretAudit(db, {
        action: existing ? 'provider.secret.write' : 'provider.secret.create',
        row: {
          id: provider.id,
          tenant_id: resolved.tenantId,
          workspace_id: workspaceId,
          owner_user_id: ownerUserId,
          secret_ref: secretRef,
        },
        secretVersion,
      });
    } finally {
      db.close();
    }
  }

  private deleteEnterprise(id: string, scope?: ProviderScope): boolean {
    const resolved = resolveProviderScope(scope);
    const oidcWriteIsolation = oidcProviderWriteIsolationEnabled();
    const row = oidcWriteIsolation
      ? this.getWritableEnterpriseRowById(id, resolved)
      : this.getAccessibleEnterpriseRowById(id, resolved);
    if (!row) return false;
    const db = openEnterpriseDb();
    try {
      const result = db.prepare(`
        DELETE FROM provider_credentials
        WHERE id = @id AND ${oidcWriteIsolation ? writableProviderWhere() : accessibleProviderWhere()}
      `).run({ ...resolved, id });
      if (result.changes > 0) {
        this.getSecretStore().delete(row.secret_ref);
        this.recordProviderSecretAudit(db, {
          action: 'provider.secret.delete',
          row,
          secretVersion: this.readSecretVersionFromPolicy(row),
        });
      }
      return result.changes > 0;
    } finally {
      db.close();
    }
  }

  private rotateEnterpriseSecret(id: string, scope?: ProviderScope): number | undefined {
    const resolved = resolveProviderScope(scope);
    const oidcWriteIsolation = oidcProviderWriteIsolationEnabled();
    const row = oidcWriteIsolation
      ? this.getWritableEnterpriseRowById(id, resolved)
      : this.getAccessibleEnterpriseRowById(id, resolved);
    if (!row) return undefined;
    const secretVersion = this.getSecretStore().rotate(row.secret_ref);
    const policy = {
      ...parseJsonObject(row.policy_json),
      secretVersion,
    };
    const db = openEnterpriseDb();
    try {
      db.prepare(`
        UPDATE provider_credentials
        SET policy_json = @policyJson, updated_at = @updatedAt
        WHERE id = @id AND ${oidcWriteIsolation ? writableProviderWhere() : accessibleProviderWhere()}
      `).run({
        ...resolved,
        id,
        policyJson: JSON.stringify(policy),
        updatedAt: Date.now(),
      });
      this.recordProviderSecretAudit(db, {
        action: 'provider.secret.rotate',
        row,
        secretVersion,
      });
      return secretVersion;
    } finally {
      db.close();
    }
  }

  private getActiveEnterprisePeer(id: string, scope?: ProviderScope): ProviderConfig | undefined {
    const resolved = resolveProviderScope(scope);
    const row = this.getAccessibleEnterpriseRowById(id, resolved);
    if (!row) return undefined;
    return this.getActiveEnterpriseInCredentialScope({
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      ownerUserId: row.owner_user_id,
      credentialScope: row.scope,
    });
  }

  private getActiveEnterpriseWriteScope(scope?: ProviderScope): ProviderConfig | undefined {
    const resolved = resolveProviderScope(scope);
    return this.getActiveEnterpriseInCredentialScope({
      tenantId: resolved.tenantId,
      workspaceId: resolved.workspaceId,
      ownerUserId: resolved.userId,
      credentialScope: resolved.userId ? 'personal' : 'workspace',
    });
  }

  private getActiveEnterpriseInCredentialScope(input: {
    tenantId: string;
    workspaceId: string | null;
    ownerUserId: string | null;
    credentialScope: ProviderCredentialScope;
  }): ProviderConfig | undefined {
    const db = openEnterpriseDb();
    try {
      const rows = db.prepare<unknown[], ProviderCredentialRow>(`
        SELECT *
        FROM provider_credentials
        WHERE tenant_id = @tenantId
          AND workspace_id IS @workspaceId
          AND owner_user_id IS @ownerUserId
          AND scope = @credentialScope
        ORDER BY updated_at DESC
      `).all(input);
      for (const row of rows) {
        const provider = this.providerFromEnterpriseRow(row);
        if (provider?.isActive) return provider;
      }
      return undefined;
    } finally {
      db.close();
    }
  }

  private getEnterpriseRowById(id: string): ProviderCredentialRow | undefined {
    const db = openEnterpriseDb();
    try {
      return db.prepare<unknown[], ProviderCredentialRow>(`
        SELECT *
        FROM provider_credentials
        WHERE id = ?
        LIMIT 1
      `).get(id);
    } finally {
      db.close();
    }
  }

  private getAccessibleEnterpriseRowById(
    id: string,
    scope: ResolvedProviderScope,
  ): ProviderCredentialRow | undefined {
    const db = openEnterpriseDb();
    try {
      return db.prepare<unknown[], ProviderCredentialRow>(`
        SELECT *
        FROM provider_credentials
        WHERE id = @id AND ${accessibleProviderWhere()}
        LIMIT 1
      `).get({ ...scope, id });
    } finally {
      db.close();
    }
  }

  private getWritableEnterpriseRowById(
    id: string,
    scope: ResolvedProviderScope,
  ): ProviderCredentialRow | undefined {
    const db = openEnterpriseDb();
    try {
      return db.prepare<unknown[], ProviderCredentialRow>(`
        SELECT *
        FROM provider_credentials
        WHERE id = @id AND ${writableProviderWhere()}
        LIMIT 1
      `).get({ ...scope, id });
    } finally {
      db.close();
    }
  }

  private providerFromEnterpriseRow(row: ProviderCredentialRow): ProviderConfig | null {
    const policy = parseJsonObject(row.policy_json) as ProviderPolicyJson;
    const models = parseJsonObject(row.models_json);
    if (typeof models.primary !== 'string' || typeof models.light !== 'string') {
      return null;
    }
    this.recordProviderSecretAudit(undefined, {
      action: 'provider.secret.read',
      row,
      secretVersion: policy.secretVersion,
    });
    const secrets = this.getSecretStore().get(row.secret_ref);
    const {connection, custom} = mergeProviderSecrets(policy.connection, policy.custom, secrets);
    return {
      id: row.id,
      name: row.name,
      category: policy.category ?? 'custom',
      type: row.type,
      isActive: policy.isActive === true,
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
      models: {
        primary: models.primary,
        light: models.light,
        ...(typeof models.subAgent === 'string' ? { subAgent: models.subAgent } : {}),
      },
      connection,
      ...(policy.tuning ? { tuning: policy.tuning } : {}),
      ...(custom ? {custom} : {}),
    };
  }

  private persist(): void {
    if (!legacyProviderWritesEnabled()) return;
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.getAll(), null, 2));
    fs.renameSync(tmp, this.filePath);
    try { fs.chmodSync(this.filePath, 0o600); } catch { /* Windows */ }
  }

  private readSecretVersionFromPolicy(row: ProviderCredentialRow): number | undefined {
    const policy = parseJsonObject(row.policy_json) as ProviderPolicyJson;
    return policy.secretVersion;
  }

  private recordProviderSecretAudit(
    db: ReturnType<typeof openEnterpriseDb> | undefined,
    input: {
      action: string;
      row: Pick<ProviderCredentialRow, 'id' | 'tenant_id' | 'workspace_id' | 'owner_user_id' | 'secret_ref'>;
      secretVersion?: number;
    },
  ): void {
    const record = (targetDb: ReturnType<typeof openEnterpriseDb>) => {
      recordEnterpriseAuditEvent(targetDb, {
        tenantId: input.row.tenant_id,
        workspaceId: input.row.workspace_id ?? undefined,
        actorUserId: input.row.owner_user_id ?? undefined,
        action: input.action,
        resourceType: 'provider_secret',
        resourceId: input.row.id,
        metadata: {
          secretRefHash: hashSecretRef(input.row.secret_ref),
          secretVersion: input.secretVersion,
          secretStore: this.getSecretStore().info(),
        },
      });
    };
    try {
      if (db) {
        record(db);
        return;
      }
      const auditDb = openEnterpriseDb();
      try {
        record(auditDb);
      } finally {
        auditDb.close();
      }
    } catch (err) {
      console.warn('[ProviderStore] Failed to record provider secret audit:', (err as Error).message);
    }
  }
}

function hashSecretRef(secretRef: string): string {
  return `sha256:${crypto.createHash('sha256').update(secretRef).digest('hex')}`;
}
