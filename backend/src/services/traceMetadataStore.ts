// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import path from 'path';
import fs from 'fs/promises';
import type Database from 'better-sqlite3';
import type { RequestContext } from '../middleware/auth';
import { openEnterpriseDb } from './enterpriseDb';
import {
  createEnterpriseWorkspaceRepository,
  repositoryScopeFromRequestContext,
  type EnterpriseRepositoryScope,
} from './enterpriseRepository';
import {
  enterpriseDbReadAuthorityEnabled,
  enterpriseDbWritesEnabled,
  legacyFilesystemWritesEnabled,
} from './enterpriseMigration';
import {
  ownerFieldsFromContext,
  type ResourceOwnerFields,
} from './resourceOwnership';
import { canReadTraceResource } from './rbac';
import { resolveEnterpriseRetentionExpiresAt } from './enterpriseQuotaPolicyService';

export interface TraceMetadata extends ResourceOwnerFields {
  id: string;
  filename: string;
  size: number;
  uploadedAt: string;
  status: string;
  path?: string;
  port?: number;
  externalRpc?: boolean;
  expiresAt?: number;
}

export interface TraceMetadataPage {
  traces: TraceMetadata[];
  nextCursor?: string;
}

export class InvalidTraceMetadataCursorError extends Error {
  constructor() {
    super('Invalid trace metadata cursor');
    this.name = 'InvalidTraceMetadataCursorError';
  }
}

interface TraceAssetRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  workspace_id: string;
  owner_user_id: string | null;
  local_path: string;
  size_bytes: number | null;
  status: string;
  metadata_json: string | null;
  created_at: number;
  expires_at: number | null;
}

const SAFE_TRACE_ID_RE = /^[a-zA-Z0-9._:-]+$/;
export const ENTERPRISE_DATA_DIR_ENV = 'SMARTPERFETTO_DATA_DIR';

export function getUploadRoot(): string {
  return process.env.UPLOAD_DIR || './uploads';
}

export function resolveEnterpriseDataRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[ENTERPRISE_DATA_DIR_ENV];
  return path.resolve(configured && configured.trim().length > 0 ? configured : 'data');
}

export function getTracesDir(): string {
  return path.join(getUploadRoot(), 'traces');
}

function enterpriseTraceStoreEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return enterpriseDbReadAuthorityEnabled(env);
}

function enterpriseTraceDbWritesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return enterpriseDbWritesEnabled(env);
}

function legacyTraceMetadataWritesEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return legacyFilesystemWritesEnabled(env);
}

function assertSafePathSegment(value: string, label: string): string {
  if (!SAFE_TRACE_ID_RE.test(value) || value === '.' || value === '..') {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  return value;
}

export function getEnterpriseTracesDirForContext(
  context: RequestContext,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(
    resolveEnterpriseDataRoot(env),
    assertSafePathSegment(context.tenantId, 'tenant id'),
    assertSafePathSegment(context.workspaceId, 'workspace id'),
    'traces',
  );
}

export function getWritableTraceDirForContext(context: RequestContext): string {
  return enterpriseTraceStoreEnabled()
    ? getEnterpriseTracesDirForContext(context)
    : getTracesDir();
}

export function isSafeTraceId(traceId: string): boolean {
  return SAFE_TRACE_ID_RE.test(traceId);
}

export function getTraceMetadataPath(traceId: string): string | null {
  if (!isSafeTraceId(traceId)) return null;
  return path.join(getTracesDir(), `${traceId}.json`);
}

export function getTraceFilePath(traceId: string): string | null {
  if (!isSafeTraceId(traceId)) return null;
  return path.join(getTracesDir(), `${traceId}.trace`);
}

function parseMetadataJson(value: string | null): Record<string, unknown> {
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

function metadataDateMs(uploadedAt: string | undefined): number {
  const parsed = uploadedAt ? Date.parse(uploadedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function traceMetadataSortTimestamp(metadata: Pick<TraceMetadata, 'uploadedAt'>): number {
  const parsed = Date.parse(metadata.uploadedAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

interface TraceMetadataCursor {
  createdAt: number;
  id: string;
}

function encodeTraceMetadataCursor(cursor: TraceMetadataCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeTraceMetadataCursor(value: string | undefined): TraceMetadataCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<TraceMetadataCursor>;
    const createdAt = parsed.createdAt;
    const id = parsed.id;
    if (typeof createdAt !== 'number' || !Number.isSafeInteger(createdAt)
      || typeof id !== 'string' || !isSafeTraceId(id)) {
      throw new InvalidTraceMetadataCursorError();
    }
    return {createdAt, id};
  } catch (error) {
    if (error instanceof InvalidTraceMetadataCursorError) throw error;
    throw new InvalidTraceMetadataCursorError();
  }
}

function metadataJsonForRow(metadata: TraceMetadata): string {
  return JSON.stringify({
    filename: metadata.filename,
    uploadedAt: metadata.uploadedAt,
    ...(typeof metadata.port === 'number' ? { port: metadata.port } : {}),
    ...(metadata.externalRpc ? { externalRpc: true } : {}),
  });
}

function rowToTraceMetadata(row: TraceAssetRow): TraceMetadata {
  const extra = parseMetadataJson(row.metadata_json);
  const filename = typeof extra.filename === 'string'
    ? extra.filename
    : path.basename(row.local_path);
  const uploadedAt = typeof extra.uploadedAt === 'string'
    ? extra.uploadedAt
    : new Date(row.created_at).toISOString();
  const port = typeof extra.port === 'number' ? extra.port : undefined;
  const externalRpc = extra.externalRpc === true;

  return {
    id: row.id,
    filename,
    size: row.size_bytes ?? 0,
    uploadedAt,
    status: row.status,
    path: row.local_path,
    tenantId: row.tenant_id,
    workspaceId: row.workspace_id,
    ...(row.owner_user_id ? { userId: row.owner_user_id } : {}),
    ...(typeof port === 'number' ? { port } : {}),
    ...(externalRpc ? { externalRpc: true } : {}),
    ...(typeof row.expires_at === 'number' ? { expiresAt: row.expires_at } : {}),
  };
}

function isTraceAssetRowLive(row: TraceAssetRow, now = Date.now()): boolean {
  return row.expires_at === null || row.expires_at > now;
}

function withEnterpriseTraceDb<T>(fn: (db: Database.Database) => T): T {
  const db = openEnterpriseDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function ensureEnterpriseTraceOwner(
  db: Database.Database,
  tenantId: string,
  workspaceId: string,
  userId: string | undefined,
): void {
  const now = Date.now();
  db.prepare(`
    INSERT OR IGNORE INTO organizations (id, name, status, plan, created_at, updated_at)
    VALUES (?, ?, 'active', 'enterprise', ?, ?)
  `).run(tenantId, tenantId, now, now);
  db.prepare(`
    INSERT OR IGNORE INTO workspaces (id, tenant_id, name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(workspaceId, tenantId, workspaceId, now, now);

  if (!userId) return;
  db.prepare(`
    INSERT INTO users (id, tenant_id, email, display_name, idp_subject, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      email = excluded.email,
      display_name = excluded.display_name,
      updated_at = excluded.updated_at
  `).run(
    userId,
    tenantId,
    `${userId}@trace.local`,
    userId,
    `trace:${userId}`,
    now,
    now,
  );
}

function enterpriseLocalPathForMetadata(metadata: TraceMetadata): string {
  if (metadata.path && metadata.path.trim().length > 0) return metadata.path;
  if (metadata.externalRpc && typeof metadata.port === 'number') {
    return `external-rpc:${metadata.port}`;
  }
  if (
    enterpriseTraceStoreEnabled() &&
    metadata.tenantId &&
    metadata.workspaceId
  ) {
    return path.join(
      resolveEnterpriseDataRoot(),
      assertSafePathSegment(metadata.tenantId, 'tenant id'),
      assertSafePathSegment(metadata.workspaceId, 'workspace id'),
      'traces',
      `${assertSafePathSegment(metadata.id, 'trace id')}.trace`,
    );
  }
  const fallbackPath = getTraceFilePath(metadata.id);
  if (!fallbackPath) throw new Error(`Unsafe trace id: ${metadata.id}`);
  return fallbackPath;
}

function writeEnterpriseTraceMetadata(metadata: TraceMetadata): void {
  if (!metadata.tenantId || !metadata.workspaceId) {
    throw new Error('Enterprise trace metadata requires tenantId and workspaceId');
  }
  const tenantId = assertSafePathSegment(metadata.tenantId, 'tenant id');
  const workspaceId = assertSafePathSegment(metadata.workspaceId, 'workspace id');
  const ownerUserId = metadata.userId
    ? assertSafePathSegment(metadata.userId, 'user id')
    : null;
  const createdAt = metadataDateMs(metadata.uploadedAt);

  withEnterpriseTraceDb((db) => {
    ensureEnterpriseTraceOwner(db, tenantId, workspaceId, ownerUserId ?? undefined);
    const expiresAt = resolveEnterpriseRetentionExpiresAt(
      db,
      { tenantId, workspaceId, ...(ownerUserId ? { userId: ownerUserId } : {}) },
      'trace',
      createdAt,
    );
    const repo = createEnterpriseWorkspaceRepository<TraceAssetRow>(db, 'trace_assets');
    const changes = repo.upsertById(
      { tenantId, workspaceId, ...(ownerUserId ? { userId: ownerUserId } : {}) },
      metadata.id,
      {
        owner_user_id: ownerUserId,
        local_path: enterpriseLocalPathForMetadata(metadata),
        size_bytes: metadata.size,
        status: metadata.status,
        metadata_json: metadataJsonForRow(metadata),
        created_at: createdAt,
        expires_at: expiresAt,
      },
    );
    if (changes === 0) {
      throw new Error('Trace metadata id already exists outside the repository scope');
    }
  });
}

export async function writeTraceMetadata(metadata: TraceMetadata): Promise<void> {
  if (!isSafeTraceId(metadata.id)) {
    throw new Error(`Unsafe trace id: ${metadata.id}`);
  }
  if (enterpriseTraceDbWritesEnabled()) {
    writeEnterpriseTraceMetadata(metadata);
  }
  if (!legacyTraceMetadataWritesEnabled()) return;
  const tracesDir = getTracesDir();
  await fs.mkdir(tracesDir, { recursive: true });
  await fs.writeFile(
    path.join(tracesDir, `${metadata.id}.json`),
    JSON.stringify(metadata, null, 2),
  );
}

/**
 * Mirror legacy/community trace metadata into the scoped SQLite graph required
 * by processor lease foreign keys. This does not change the active metadata
 * read/write mode.
 */
export function ensureTraceProcessorLeaseBackingMetadata(
  metadata: TraceMetadata,
  scope: EnterpriseRepositoryScope,
): void {
  writeEnterpriseTraceMetadata({
    ...metadata,
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    ...(scope.userId ? {userId: scope.userId} : {}),
  });
}

export function deleteTraceProcessorLeaseBackingMetadata(
  traceId: string,
  scope: EnterpriseRepositoryScope,
): void {
  withEnterpriseTraceDb((db) => {
    createEnterpriseWorkspaceRepository<TraceAssetRow>(db, 'trace_assets')
      .deleteById(scope, traceId);
  });
}

function readEnterpriseTraceMetadata(traceId: string): TraceMetadata | null {
  return withEnterpriseTraceDb((db) => {
    const row = db.prepare<unknown[], TraceAssetRow>(`
      SELECT *
      FROM trace_assets
      WHERE id = ?
        AND (expires_at IS NULL OR expires_at > ?)
    `).get(traceId, Date.now());
    return row ? rowToTraceMetadata(row) : null;
  });
}

function readEnterpriseTraceMetadataForScope(
  traceId: string,
  scope: EnterpriseRepositoryScope,
): TraceMetadata | null {
  return withEnterpriseTraceDb((db) => {
    const repo = createEnterpriseWorkspaceRepository<TraceAssetRow>(db, 'trace_assets');
    const row = repo.getById(scope, traceId);
    return row && isTraceAssetRowLive(row) ? rowToTraceMetadata(row) : null;
  });
}

export async function readTraceMetadata(traceId: string): Promise<TraceMetadata | null> {
  if (enterpriseTraceStoreEnabled()) {
    if (!isSafeTraceId(traceId)) return null;
    return readEnterpriseTraceMetadata(traceId);
  }

  const metadataPath = getTraceMetadataPath(traceId);
  if (!metadataPath) return null;

  try {
    const raw = await fs.readFile(metadataPath, 'utf8');
    const parsed = JSON.parse(raw) as TraceMetadata;
    if (!parsed || parsed.id !== traceId) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function listEnterpriseTraceMetadata(): TraceMetadata[] {
  return withEnterpriseTraceDb((db) => {
    const rows = db.prepare<unknown[], TraceAssetRow>(`
      SELECT *
      FROM trace_assets
      WHERE expires_at IS NULL OR expires_at > ?
      ORDER BY created_at DESC
    `).all(Date.now());
    return rows.map(rowToTraceMetadata);
  });
}

export async function listTraceMetadata(): Promise<TraceMetadata[]> {
  if (enterpriseTraceStoreEnabled()) {
    return listEnterpriseTraceMetadata();
  }

  const tracesDir = getTracesDir();
  let files: string[];
  try {
    files = await fs.readdir(tracesDir);
  } catch {
    return [];
  }

  const traces: TraceMetadata[] = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const traceId = file.slice(0, -'.json'.length);
    const metadata = await readTraceMetadata(traceId);
    if (metadata) traces.push(metadata);
  }
  return traces;
}

export async function listTraceMetadataForContext(context: RequestContext): Promise<TraceMetadata[]> {
  if (enterpriseTraceStoreEnabled()) {
    return withEnterpriseTraceDb((db) => {
      const repo = createEnterpriseWorkspaceRepository<TraceAssetRow>(db, 'trace_assets');
      const now = Date.now();
      return repo.list(repositoryScopeFromRequestContext(context), {}, {
        orderBy: 'created_at',
        direction: 'DESC',
      })
        .filter(row => isTraceAssetRowLive(row, now))
        .map(rowToTraceMetadata)
        .filter(metadata => canReadTraceResource(metadata, context));
    });
  }

  return (await listTraceMetadata()).filter(trace => canReadTraceResource(trace, context));
}

export async function listTraceMetadataPageForContext(
  context: RequestContext,
  options: {limit: number; cursor?: string},
): Promise<TraceMetadataPage> {
  if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 200) {
    throw new RangeError('Trace metadata page limit must be between 1 and 200');
  }
  const cursor = decodeTraceMetadataCursor(options.cursor);

  if (enterpriseTraceStoreEnabled()) {
    return withEnterpriseTraceDb((db) => {
      const rows = db.prepare<unknown[], TraceAssetRow>(`
        SELECT *
        FROM trace_assets
        WHERE tenant_id = @tenantId
          AND workspace_id = @workspaceId
          AND (expires_at IS NULL OR expires_at > @now)
          AND (
            @cursorCreatedAt IS NULL
            OR created_at < @cursorCreatedAt
            OR (created_at = @cursorCreatedAt AND id < @cursorId)
          )
        ORDER BY created_at DESC, id DESC
        LIMIT @rowLimit
      `).all({
        tenantId: context.tenantId,
        workspaceId: context.workspaceId,
        now: Date.now(),
        cursorCreatedAt: cursor?.createdAt ?? null,
        cursorId: cursor?.id ?? '',
        rowLimit: options.limit + 1,
      });
      const visibleRows = rows.filter(row => canReadTraceResource(rowToTraceMetadata(row), context));
      const pageRows = visibleRows.slice(0, options.limit);
      const lastRow = pageRows[pageRows.length - 1];
      return {
        traces: pageRows.map(rowToTraceMetadata),
        ...(visibleRows.length > options.limit && lastRow
          ? {nextCursor: encodeTraceMetadataCursor({createdAt: lastRow.created_at, id: lastRow.id})}
          : {}),
      };
    });
  }

  const ordered = (await listTraceMetadata())
    .filter(trace => canReadTraceResource(trace, context))
    .sort((left, right) => (
      traceMetadataSortTimestamp(right) - traceMetadataSortTimestamp(left)
      || right.id.localeCompare(left.id)
    ))
    .filter(trace => !cursor
      || traceMetadataSortTimestamp(trace) < cursor.createdAt
      || (traceMetadataSortTimestamp(trace) === cursor.createdAt && trace.id < cursor.id));
  const page = ordered.slice(0, options.limit);
  const last = page[page.length - 1];
  return {
    traces: page,
    ...(ordered.length > options.limit && last
      ? {nextCursor: encodeTraceMetadataCursor({
          createdAt: traceMetadataSortTimestamp(last),
          id: last.id,
        })}
      : {}),
  };
}

export async function countTraceMetadataForContext(context: RequestContext): Promise<number> {
  if (!canReadTraceResource(ownerFieldsFromContext(context), context)) return 0;
  if (enterpriseTraceStoreEnabled()) {
    return withEnterpriseTraceDb((db) => {
      const row = db.prepare<unknown[], {count: number}>(`
        SELECT COUNT(*) AS count
        FROM trace_assets
        WHERE tenant_id = ?
          AND workspace_id = ?
          AND (expires_at IS NULL OR expires_at > ?)
      `).get(context.tenantId, context.workspaceId, Date.now());
      return row?.count ?? 0;
    });
  }
  return (await listTraceMetadata()).filter(trace => canReadTraceResource(trace, context)).length;
}

export async function deleteTraceMetadata(traceId: string): Promise<void> {
  if (!isSafeTraceId(traceId)) return;
  if (enterpriseTraceDbWritesEnabled()) {
    withEnterpriseTraceDb((db) => {
      db.prepare('DELETE FROM trace_assets WHERE id = ?').run(traceId);
    });
  }
  if (!legacyTraceMetadataWritesEnabled()) return;
  const metadataPath = getTraceMetadataPath(traceId);
  if (!metadataPath) return;
  try {
    await fs.unlink(metadataPath);
  } catch {
    // Already deleted.
  }
}

export async function deleteTraceMetadataForContext(
  traceId: string,
  context: RequestContext,
): Promise<void> {
  if (!isSafeTraceId(traceId)) return;
  if (enterpriseTraceDbWritesEnabled()) {
    withEnterpriseTraceDb((db) => {
      createEnterpriseWorkspaceRepository<TraceAssetRow>(db, 'trace_assets')
        .deleteById(repositoryScopeFromRequestContext(context), traceId);
    });
  }
  if (!legacyTraceMetadataWritesEnabled()) return;
  const metadataPath = getTraceMetadataPath(traceId);
  if (!metadataPath) return;
  try {
    await fs.unlink(metadataPath);
  } catch {
    // Already deleted.
  }
}

export function buildTraceOwnerMetadata(context: RequestContext): ResourceOwnerFields {
  return ownerFieldsFromContext(context);
}

export function isTraceMetadataOwnedByContext(
  metadata: TraceMetadata | null | undefined,
  context: RequestContext,
): metadata is TraceMetadata {
  return Boolean(metadata && canReadTraceResource(metadata, context));
}

export async function readTraceMetadataForContext(
  traceId: string,
  context: RequestContext,
): Promise<TraceMetadata | null> {
  if (enterpriseTraceStoreEnabled()) {
    if (!isSafeTraceId(traceId)) return null;
    const metadata = readEnterpriseTraceMetadataForScope(
      traceId,
      repositoryScopeFromRequestContext(context),
    );
    return isTraceMetadataOwnedByContext(metadata, context) ? metadata : null;
  }

  const metadata = await readTraceMetadata(traceId);
  return isTraceMetadataOwnedByContext(metadata, context) ? metadata : null;
}
