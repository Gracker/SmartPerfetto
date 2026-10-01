// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import type Database from 'better-sqlite3';

import type { RequestContext } from '../middleware/auth';
import { stableStringify } from '../utils/stableJson';

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface TenantExportWorkspaceRow {
  id: string;
  tenant_id: string;
  name: string;
  retention_policy: string | null;
  quota_policy: string | null;
  created_at: number;
  updated_at: number;
}

interface TenantExportOrganizationRow {
  id: string;
  name: string;
  status: string;
  plan: string | null;
  created_at: number;
  updated_at: number;
}

interface TenantExportUserRow {
  id: string;
  tenant_id: string;
  email: string;
  display_name: string | null;
  idp_subject: string | null;
  created_at: number;
  updated_at: number;
}

interface TenantExportMembershipRow {
  tenant_id: string;
  workspace_id: string;
  user_id: string;
  role: string;
  created_at: number;
}

interface TenantExportTraceRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  owner_user_id: string | null;
  sha256: string | null;
  size_bytes: number | null;
  status: string;
  metadata_json: string | null;
  created_at: number;
  expires_at: number | null;
}

interface TenantExportReportRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  session_id: string;
  run_id: string;
  local_path: string;
  content_hash: string | null;
  visibility: string;
  created_by: string | null;
  created_at: number;
  expires_at: number | null;
}

interface TenantExportAnalysisSessionRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  trace_id: string;
  created_by: string | null;
  provider_snapshot_id: string | null;
  title: string | null;
  visibility: string;
  status: string;
  created_at: number;
  updated_at: number;
}

interface TenantExportAnalysisRunRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  session_id: string;
  mode: string;
  status: string;
  question: string;
  started_at: number;
  completed_at: number | null;
  error_json: string | null;
  heartbeat_at: number | null;
  updated_at: number | null;
}

interface TenantExportConversationTurnRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  session_id: string;
  run_id: string;
  role: string;
  content_json: string;
  created_at: number;
}

interface TenantExportMemoryRow {
  id: string;
  tenant_id: string;
  workspace_id: string;
  scope: string;
  source_run_id: string | null;
  content_json: string;
  embedding_ref: string | null;
  created_at: number;
  updated_at: number;
}

interface TenantExportProviderCredentialRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  owner_user_id: string | null;
  scope: string;
  name: string;
  type: string;
  models_json: string;
  policy_json: string | null;
  created_at: number;
  updated_at: number;
}

interface TenantExportProviderSnapshotRow {
  id: string;
  tenant_id: string;
  provider_id: string;
  snapshot_hash: string;
  runtime_kind: string;
  resolved_config_json: string;
  secret_version: string | null;
  created_at: number;
}

interface TenantExportAuditRow {
  id: string;
  tenant_id: string;
  workspace_id: string | null;
  actor_user_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  metadata_json: string | null;
  created_at: number;
}

export interface TenantExportBundle {
  schemaVersion: 1;
  generatedAt: string;
  tenantIdentityProof: {
    tenantId: string;
    organizationHash: string;
    workspaceIds: string[];
    generatedBy: string;
    requestId: string;
    proofHash: string;
  };
  manifest: {
    traceFilesIncluded: false;
    traceCount: number;
    reportCount: number;
    sessionCount: number;
    runCount: number;
    turnCount: number;
    memoryRecordCount: number;
    auditEventCount: number;
    providerCredentialCount: number;
    providerSnapshotCount: number;
  };
  tenant: {
    organization: Record<string, JsonValue> | null;
    workspaces: Array<Record<string, JsonValue>>;
    users: Array<Record<string, JsonValue>>;
    memberships: Array<Record<string, JsonValue>>;
  };
  traces: Array<Record<string, JsonValue>>;
  reports: Array<Record<string, JsonValue>>;
  sessions: Array<Record<string, JsonValue>>;
  runs: Array<Record<string, JsonValue>>;
  turns: Array<Record<string, JsonValue>>;
  knowledge: {
    memoryEntries: Array<Record<string, JsonValue>>;
  };
  auditEvents: Array<Record<string, JsonValue>>;
  providers: {
    credentials: Array<Record<string, JsonValue>>;
    snapshots: Array<Record<string, JsonValue>>;
  };
}

export interface TenantExportResult {
  bundle: TenantExportBundle;
  bundleSha256: string;
  canonicalPayload: string;
  filename: string;
}

const SENSITIVE_KEY_RE = /(api[_-]?key|token|secret|password|credential|bearer|authorization)/i;

function parseJson(value: string | null): JsonValue | null {
  if (!value) return null;
  try {
    return sanitizeJson(JSON.parse(value));
  } catch {
    return null;
  }
}

function sanitizeJson(value: unknown): JsonValue {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(item => sanitizeJson(item));
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, child]) =>
    [key, SENSITIVE_KEY_RE.test(key) ? '[redacted]' : sanitizeJson(child)]));
}

function sha256(value: string): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
}

function toIso(value: number | null | undefined): string | null {
  return typeof value === 'number' ? new Date(value).toISOString() : null;
}

async function tryReadText(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
}

function organizationExport(row: TenantExportOrganizationRow | null): Record<string, JsonValue> | null {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    plan: row.plan,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function workspaceExport(row: TenantExportWorkspaceRow): Record<string, JsonValue> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    name: row.name,
    retentionPolicy: parseJson(row.retention_policy),
    quotaPolicy: parseJson(row.quota_policy),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function userExport(row: TenantExportUserRow): Record<string, JsonValue> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    email: row.email,
    displayName: row.display_name,
    idpSubject: row.idp_subject,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function membershipExport(row: TenantExportMembershipRow): Record<string, JsonValue> {
  return {
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    role: row.role,
    createdAt: toIso(row.created_at),
  };
}

function traceManifestExport(row: TenantExportTraceRow): Record<string, JsonValue> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    sha256: row.sha256,
    sizeBytes: row.size_bytes,
    status: row.status,
    metadata: parseJson(row.metadata_json),
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    fileIncluded: false,
  };
}

async function reportExport(row: TenantExportReportRow): Promise<Record<string, JsonValue>> {
  const html = await tryReadText(row.local_path);
  const jsonPath = path.join(path.dirname(row.local_path), 'report.json');
  const reportJson = parseJson(await tryReadText(jsonPath));
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    runId: row.run_id,
    contentHash: row.content_hash,
    visibility: row.visibility,
    createdBy: row.created_by,
    createdAt: toIso(row.created_at),
    expiresAt: toIso(row.expires_at),
    html,
    json: reportJson,
  };
}

function sessionExport(row: TenantExportAnalysisSessionRow): Record<string, JsonValue> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    traceId: row.trace_id,
    createdBy: row.created_by,
    providerSnapshotId: row.provider_snapshot_id,
    title: row.title,
    visibility: row.visibility,
    status: row.status,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function runExport(row: TenantExportAnalysisRunRow): Record<string, JsonValue> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    mode: row.mode,
    status: row.status,
    question: row.question,
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    heartbeatAt: toIso(row.heartbeat_at),
    updatedAt: toIso(row.updated_at),
    error: parseJson(row.error_json),
  };
}

function turnExport(row: TenantExportConversationTurnRow): Record<string, JsonValue> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    runId: row.run_id,
    role: row.role,
    content: parseJson(row.content_json),
    createdAt: toIso(row.created_at),
  };
}

function memoryExport(row: TenantExportMemoryRow): Record<string, JsonValue> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    scope: row.scope,
    sourceRunId: row.source_run_id,
    content: parseJson(row.content_json),
    embeddingRef: row.embedding_ref,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function providerCredentialExport(row: TenantExportProviderCredentialRow): Record<string, JsonValue> {
  const policy = parseJson(row.policy_json) as Record<string, JsonValue> | null;
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    ownerUserId: row.owner_user_id,
    scope: row.scope,
    name: row.name,
    type: row.type,
    models: parseJson(row.models_json),
    policy,
    secretConfigured: true,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function providerSnapshotExport(row: TenantExportProviderSnapshotRow): Record<string, JsonValue> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    providerId: row.provider_id,
    snapshotHash: row.snapshot_hash,
    runtimeKind: row.runtime_kind,
    resolvedConfig: parseJson(row.resolved_config_json),
    secretVersion: row.secret_version,
    createdAt: toIso(row.created_at),
  };
}

function auditExport(row: TenantExportAuditRow): Record<string, JsonValue> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    actorUserId: row.actor_user_id,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    metadata: parseJson(row.metadata_json),
    createdAt: toIso(row.created_at),
  };
}

function tenantRows<T>(db: Database.Database, table: string, tenantId: string, orderBy: string): T[] {
  return db.prepare<unknown[], T>(`
    SELECT *
    FROM ${table}
    WHERE tenant_id = ?
    ORDER BY ${orderBy}
  `).all(tenantId);
}

export async function buildTenantExportBundle(
  db: Database.Database,
  context: RequestContext,
): Promise<TenantExportResult> {
  const generatedAt = new Date().toISOString();
  const organization = db.prepare<unknown[], TenantExportOrganizationRow>(`
    SELECT *
    FROM organizations
    WHERE id = ?
    LIMIT 1
  `).get(context.tenantId) ?? null;
  const workspaces = tenantRows<TenantExportWorkspaceRow>(db, 'workspaces', context.tenantId, 'id ASC');
  const workspaceIds = workspaces.map(workspace => workspace.id);

  const reports = await Promise.all(
    tenantRows<TenantExportReportRow>(db, 'report_artifacts', context.tenantId, 'workspace_id ASC, id ASC')
      .map(reportExport),
  );
  const traces = tenantRows<TenantExportTraceRow>(db, 'trace_assets', context.tenantId, 'workspace_id ASC, id ASC')
    .map(traceManifestExport);
  const sessions = tenantRows<TenantExportAnalysisSessionRow>(
    db,
    'analysis_sessions',
    context.tenantId,
    'workspace_id ASC, created_at ASC, id ASC',
  ).map(sessionExport);
  const runs = tenantRows<TenantExportAnalysisRunRow>(
    db,
    'analysis_runs',
    context.tenantId,
    'workspace_id ASC, started_at ASC, id ASC',
  ).map(runExport);
  const turns = tenantRows<TenantExportConversationTurnRow>(
    db,
    'conversation_turns',
    context.tenantId,
    'workspace_id ASC, created_at ASC, id ASC',
  ).map(turnExport);
  const memoryEntries = tenantRows<TenantExportMemoryRow>(
    db,
    'memory_entries',
    context.tenantId,
    'workspace_id ASC, updated_at ASC, id ASC',
  ).map(memoryExport);
  const auditEvents = tenantRows<TenantExportAuditRow>(
    db,
    'audit_events',
    context.tenantId,
    'created_at ASC, id ASC',
  ).map(auditExport);
  const providerCredentials = tenantRows<TenantExportProviderCredentialRow>(
    db,
    'provider_credentials',
    context.tenantId,
    'COALESCE(workspace_id, \'\') ASC, id ASC',
  ).map(providerCredentialExport);
  const providerSnapshots = tenantRows<TenantExportProviderSnapshotRow>(
    db,
    'provider_snapshots',
    context.tenantId,
    'created_at ASC, id ASC',
  ).map(providerSnapshotExport);

  const tenant = {
    organization: organizationExport(organization),
    workspaces: workspaces.map(workspaceExport),
    users: tenantRows<TenantExportUserRow>(db, 'users', context.tenantId, 'id ASC').map(userExport),
    memberships: tenantRows<TenantExportMembershipRow>(
      db,
      'memberships',
      context.tenantId,
      'workspace_id ASC, user_id ASC',
    ).map(membershipExport),
  };
  const organizationHash = sha256(stableStringify(tenant.organization));
  const proofPayload = {
    tenantId: context.tenantId,
    organizationHash,
    workspaceIds,
    generatedAt,
    generatedBy: context.userId,
    requestId: context.requestId,
  };
  const bundle: TenantExportBundle = {
    schemaVersion: 1,
    generatedAt,
    tenantIdentityProof: {
      tenantId: context.tenantId,
      organizationHash,
      workspaceIds,
      generatedBy: context.userId,
      requestId: context.requestId,
      proofHash: sha256(stableStringify(proofPayload)),
    },
    manifest: {
      traceFilesIncluded: false,
      traceCount: traces.length,
      reportCount: reports.length,
      sessionCount: sessions.length,
      runCount: runs.length,
      turnCount: turns.length,
      memoryRecordCount: memoryEntries.length,
      auditEventCount: auditEvents.length,
      providerCredentialCount: providerCredentials.length,
      providerSnapshotCount: providerSnapshots.length,
    },
    tenant,
    traces,
    reports,
    sessions,
    runs,
    turns,
    knowledge: {
      memoryEntries,
    },
    auditEvents,
    providers: {
      credentials: providerCredentials,
      snapshots: providerSnapshots,
    },
  };
  const canonicalPayload = stableStringify(bundle);
  const bundleSha256 = sha256(canonicalPayload);
  const generatedForFilename = generatedAt.replace(/[:.]/g, '-');
  return {
    bundle,
    bundleSha256,
    canonicalPayload,
    filename: `smartperfetto-tenant-${context.tenantId}-${generatedForFilename}.json`,
  };
}
