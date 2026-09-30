// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import crypto from 'crypto';
import type Database from 'better-sqlite3';

import type { RequestContext } from '../middleware/auth';
import { openEnterpriseDb, openEnterpriseDbReadOnly } from './enterpriseDb';
import { RETIRED_RAG_CHUNK_SQL } from './retiredCaseData';
import { createEnterpriseWorkspaceRepository } from './enterpriseRepository';
import {
  enterpriseDbReadAuthorityEnabled,
  enterpriseDbWritesEnabled,
  legacyFilesystemWritesEnabled,
} from './enterpriseMigration';
import {buildRagSearchTokenText} from './rag/searchTokens';

const DEFAULT_TENANT_ID = 'default-dev-tenant';
const DEFAULT_WORKSPACE_ID = 'default-workspace';
const DEFAULT_USER_ID = 'dev-user-123';
const SAFE_SCOPE_SEGMENT_RE = /^[a-zA-Z0-9._:-]+$/;

interface KnowledgeEntryRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  workspace_id: string;
  scope: string;
  source_run_id: string | null;
  content_json: string;
  embedding_ref: string | null;
  rag_registry_origin: string | null;
  rag_codebase_id: string | null;
  rag_knowledge_source_id: string | null;
  rag_source_generation: string | null;
  rag_scope_fingerprint: string | null;
  rag_unsupported_reason: string | null;
  rag_vendor: string | null;
  rag_build_id: string | null;
  rag_language: string | null;
  rag_symbol: string | null;
  rag_lookup_path: string | null;
  created_at: number;
  updated_at: number;
}

interface KnowledgeEnvelope<T> {
  schemaVersion: 1;
  kind: string;
  externalId: string;
  sourceTenantId: string;
  sourceWorkspaceId: string;
  sourceRunId?: string;
  record: T;
}

export interface KnowledgeScope {
  tenantId?: string;
  workspaceId?: string;
  userId?: string;
  sourceRunId?: string;
  runId?: string;
}

export interface ResolvedKnowledgeScope {
  tenantId: string;
  workspaceId: string;
  userId?: string;
  sourceRunId?: string;
}

export interface ScopedKnowledgeRecord<T> {
  externalId: string;
  rowScope: string;
  record: T;
  sourceRunId?: string;
  createdAt: number;
  updatedAt: number;
}

/** Enumerate DB partitions that own one of the requested row scopes. */
export function listScopedKnowledgePartitions(
  rowScopes: readonly string[],
  opts: KnowledgeReadOptions = {},
): KnowledgeScope[] {
  if (rowScopes.length === 0) return [];
  return readKnowledgeDb(opts, (db) => {
    const params: Record<string, string> = {};
    const placeholders = rowScopes.map((rowScope, index) => {
      params[`rowScope${index}`] = rowScope;
      return `@rowScope${index}`;
    });
    return db.prepare<unknown[], {tenant_id: string; workspace_id: string}>(`
      SELECT DISTINCT tenant_id, workspace_id
      FROM memory_entries
      WHERE scope IN (${placeholders.join(', ')})
      ORDER BY tenant_id, workspace_id
    `).all(params).map(row => ({
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
    }));
  }) ?? [];
}

interface KnowledgeReadOptions {
  /** Never create or migrate the database; with no database yet, read nothing. */
  readOnly?: boolean;
  /** A row that exists but cannot be decoded throws instead of reading as missing. */
  requireReadable?: boolean;
}

interface ListOptions {
  rowScope?: string;
  rowScopePrefix?: string;
  includeSystem?: boolean;
  /** A listed row that cannot be decoded throws instead of being skipped. */
  requireReadable?: boolean;
}

interface UpsertOptions {
  createdAt?: number;
  updatedAt?: number;
  sourceRunId?: string;
  embeddingRef?: string;
}

export interface ScopedKnowledgeUpsert<T> {
  kind: string;
  externalId: string;
  rowScope: string;
  record: T;
  options?: UpsertOptions;
}

export interface ScopedRagGenerationPair {
  id: string;
  generation: string;
}

export interface ScopedRagSearchOptions {
  rowScopes?: readonly string[];
  selection: 'public' | 'codebase' | 'knowledge' | 'none';
  codebaseGenerations?: readonly ScopedRagGenerationPair[];
  knowledgeSourceGenerations?: readonly ScopedRagGenerationPair[];
  scopeFingerprint?: string;
  queryTokens?: readonly string[];
  candidateLimit?: number;
  vendor?: string;
  buildId?: string;
  pathPrefix?: string;
  symbolExact?: string;
  filePathExact?: string;
  languages?: readonly string[];
  includeSystem?: boolean;
}

export interface ScopedRagSearchResult<T> {
  records: ScopedKnowledgeRecord<T>[];
  indexHasRows: boolean;
  eligibleHasRows: boolean;
}

export interface ScopedRagMaintenanceFilter {
  codebaseId?: string;
  knowledgeSourceId?: string;
  sourceGeneration?: string;
  excludeSourceGeneration?: string;
  scopeFingerprint?: string;
}

export const SCOPED_KNOWLEDGE_WRITE_BATCH_SIZE = 1_000;

function escapeSqlLikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, character => `\\${character}`);
}

interface MutateOptions extends UpsertOptions {
  rowScope: string;
}

interface ScopedKnowledgeMutation<T> {
  kind: string;
  externalId: string;
  mutate: (current: T | undefined) => T;
  options: MutateOptions;
}

export function enterpriseKnowledgeStoreEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return enterpriseDbReadAuthorityEnabled(env);
}

export function enterpriseKnowledgeDbWritesEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return enterpriseDbWritesEnabled(env);
}

export function legacyKnowledgeFilesystemWritesEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return legacyFilesystemWritesEnabled(env);
}

export function knowledgeScopeFromRequestContext(
  context: RequestContext,
): KnowledgeScope {
  return {
    tenantId: context.tenantId,
    workspaceId: context.workspaceId,
    userId: context.userId,
  };
}

export function resolveKnowledgeScope(
  scope: KnowledgeScope = {},
): ResolvedKnowledgeScope {
  const tenantId = sanitizeScopeSegment(
    scope.tenantId || DEFAULT_TENANT_ID,
    'tenantId',
  );
  const workspaceId = sanitizeScopeSegment(
    scope.workspaceId || DEFAULT_WORKSPACE_ID,
    'workspaceId',
  );
  const userId = scope.userId
    ? sanitizeScopeSegment(scope.userId, 'userId')
    : DEFAULT_USER_ID;
  const sourceRunId = scope.sourceRunId || scope.runId;
  return {
    tenantId,
    workspaceId,
    ...(userId ? {userId} : {}),
    ...(sourceRunId
      ? {sourceRunId: sanitizeScopeSegment(sourceRunId, 'sourceRunId')}
      : {}),
  };
}

export function scopedKnowledgeRowId(
  kind: string,
  externalId: string,
  scope: Pick<ResolvedKnowledgeScope, 'tenantId' | 'workspaceId'>,
): string {
  const digest = crypto
    .createHash('sha256')
    .update(`${scope.tenantId}\0${scope.workspaceId}\0${kind}\0${externalId}`)
    .digest('hex')
    .slice(0, 32);
  return `knowledge-${digest}`;
}

export function upsertScopedKnowledgeRecord<T>(
  kind: string,
  externalId: string,
  rowScope: string,
  record: T,
  scopeInput?: KnowledgeScope,
  opts: UpsertOptions = {},
): void {
  upsertScopedKnowledgeRecords([{
    kind,
    externalId,
    rowScope,
    record,
    options: opts,
  }], scopeInput);
}

/**
 * Upsert a large knowledge generation with one SQLite connection and bounded
 * IMMEDIATE transactions. This avoids one open/migrate/transaction/close cycle
 * per RAG chunk while still yielding the writer lock between 1k-row batches.
 */
export function upsertScopedKnowledgeRecords<T>(
  entries: readonly ScopedKnowledgeUpsert<T>[],
  scopeInput?: KnowledgeScope,
): void {
  if (entries.length === 0) return;
  const scope = resolveKnowledgeScope(scopeInput);
  withKnowledgeDb((db) => {
    const repo = createEnterpriseWorkspaceRepository<KnowledgeEntryRow>(db, 'memory_entries');
    let graphEnsured = false;
    for (let offset = 0; offset < entries.length; offset += SCOPED_KNOWLEDGE_WRITE_BATCH_SIZE) {
      const batch = entries.slice(offset, offset + SCOPED_KNOWLEDGE_WRITE_BATCH_SIZE);
      const tx = db.transaction(() => {
        if (!graphEnsured) {
          ensureEnterpriseKnowledgeGraph(db, scope);
          graphEnsured = true;
        }
        for (const entry of batch) {
          upsertScopedKnowledgeRecordInDb(db, repo, scope, entry);
        }
      });
      tx.immediate();
    }
  });
}

/**
 * Atomically read-modify-write one scoped record while holding the SQLite
 * writer lock. Policy records use this to avoid stale multi-instance updates
 * re-enabling consent that another instance just revoked.
 */
export function mutateScopedKnowledgeRecord<T>(
  kind: string,
  externalId: string,
  scopeInput: KnowledgeScope | undefined,
  mutate: (current: T | undefined) => T,
  opts: MutateOptions,
): T {
  const scope = resolveKnowledgeScope(scopeInput);
  return withKnowledgeDb((db) => {
    const tx = db.transaction(() => {
      ensureEnterpriseKnowledgeGraph(db, scope);
      return mutateScopedKnowledgeRecordInDb(db, scope, {
        kind,
        externalId,
        mutate,
        options: opts,
      });
    });
    return tx.immediate();
  });
}

/**
 * Atomically update one SQLite record and a synchronous replica side effect.
 * The side effect runs after the database write but before COMMIT, so a file
 * lock/persist failure rolls the SQLite transaction back instead of leaving a
 * silently successful half-write.
 */
export function mutateScopedKnowledgeRecordWithSideEffect<T>(
  kind: string,
  externalId: string,
  scopeInput: KnowledgeScope | undefined,
  mutate: (current: T | undefined) => {record: T; rowScope: string},
  sideEffect: (record: T, current: T | undefined) => void,
  opts: UpsertOptions = {},
): T {
  const scope = resolveKnowledgeScope(scopeInput);
  return withKnowledgeDb((db) => {
    const tx = db.transaction(() => {
      ensureEnterpriseKnowledgeGraph(db, scope);
      const repo = createEnterpriseWorkspaceRepository<KnowledgeEntryRow>(db, 'memory_entries');
      const rowId = scopedKnowledgeRowId(kind, externalId, scope);
      const existing = repo.getById(scope, rowId);
      const current = existing
        ? parseKnowledgeRow<T>(kind, existing)?.record
        : undefined;
      const next = mutate(current);
      upsertScopedKnowledgeRecordInDb(db, repo, scope, {
        kind,
        externalId,
        rowScope: next.rowScope,
        record: next.record,
        options: opts,
      });
      sideEffect(next.record, current);
      return next.record;
    });
    return tx.immediate();
  });
}

/** Delete an exact record only if its current payload still matches. */
export function removeScopedKnowledgeRecordIf<T>(
  kind: string,
  externalId: string,
  scopeInput: KnowledgeScope | undefined,
  predicate: (current: T) => boolean,
  sideEffect: (current: T) => void = () => undefined,
): boolean {
  const scope = resolveKnowledgeScope(scopeInput);
  return withKnowledgeDb((db) => {
    const tx = db.transaction(() => {
      const repo = createEnterpriseWorkspaceRepository<KnowledgeEntryRow>(db, 'memory_entries');
      const rowId = scopedKnowledgeRowId(kind, externalId, scope);
      const row = repo.getById(scope, rowId);
      const current = row ? parseKnowledgeRow<T>(kind, row)?.record : undefined;
      if (!current || !predicate(current)) return false;
      db.prepare('DELETE FROM rag_knowledge_fts WHERE entry_id = ?').run(rowId);
      if (repo.deleteById(scope, rowId) === 0) return false;
      sideEffect(current);
      return true;
    });
    return tx.immediate();
  });
}

/**
 * Atomically mutate two scoped policy records under one SQLite IMMEDIATE
 * transaction. This is used when a policy mutation must be fenced by a lease:
 * validating/renewing the lease and changing the protected record cannot be
 * separated by a process scheduling window.
 */
export function mutateScopedKnowledgeRecordPair<TFirst, TSecond>(
  first: ScopedKnowledgeMutation<TFirst>,
  second: ScopedKnowledgeMutation<TSecond>,
  scopeInput?: KnowledgeScope,
): {first: TFirst; second: TSecond} {
  const scope = resolveKnowledgeScope(scopeInput);
  return withKnowledgeDb((db) => {
    const tx = db.transaction(() => {
      ensureEnterpriseKnowledgeGraph(db, scope);
      return {
        first: mutateScopedKnowledgeRecordInDb(db, scope, first),
        second: mutateScopedKnowledgeRecordInDb(db, scope, second),
      };
    });
    return tx.immediate();
  });
}

export function getScopedKnowledgeRecord<T>(
  kind: string,
  externalId: string,
  scopeInput?: KnowledgeScope,
  opts: KnowledgeReadOptions = {},
): ScopedKnowledgeRecord<T> | undefined {
  const scope = resolveKnowledgeScope(scopeInput);
  return readKnowledgeDb(opts, (db) => {
    const repo = createEnterpriseWorkspaceRepository<KnowledgeEntryRow>(
      db,
      'memory_entries',
    );
    const row = repo.getById(
      scope,
      scopedKnowledgeRowId(kind, externalId, scope),
    );
    if (!row) return undefined;
    const record = parseKnowledgeRow<T>(kind, row);
    if (!record && opts.requireReadable) throw new Error('knowledge_record_unreadable');
    return record;
  });
}

export function removeScopedKnowledgeRecord(
  kind: string,
  externalId: string,
  scopeInput?: KnowledgeScope,
): boolean {
  return removeScopedKnowledgeRecords(kind, [externalId], scopeInput) > 0;
}

/** Delete exact scoped ids using one connection and bounded transactions. */
export function removeScopedKnowledgeRecords(
  kind: string,
  externalIds: readonly string[],
  scopeInput?: KnowledgeScope,
): number {
  const uniqueIds = Array.from(new Set(externalIds));
  if (uniqueIds.length === 0) return 0;
  const scope = resolveKnowledgeScope(scopeInput);
  return withKnowledgeDb((db) => {
    const repo = createEnterpriseWorkspaceRepository<KnowledgeEntryRow>(db, 'memory_entries');
    let removed = 0;
    for (let offset = 0; offset < uniqueIds.length; offset += SCOPED_KNOWLEDGE_WRITE_BATCH_SIZE) {
      const batch = uniqueIds.slice(offset, offset + SCOPED_KNOWLEDGE_WRITE_BATCH_SIZE);
      const tx = db.transaction(() => {
        for (const externalId of batch) {
          const rowId = scopedKnowledgeRowId(kind, externalId, scope);
          db.prepare('DELETE FROM rag_knowledge_fts WHERE entry_id = ?').run(rowId);
          removed += repo.deleteById(
            scope,
            rowId,
          );
        }
      });
      tx.immediate();
    }
    return removed;
  });
}

function scopedRagMaintenanceWhere(
  scope: ResolvedKnowledgeScope,
  filter: ScopedRagMaintenanceFilter,
): {where: string; params: Record<string, string>} {
  if (Boolean(filter.codebaseId) === Boolean(filter.knowledgeSourceId)) {
    throw new Error('Exactly one RAG maintenance owner id is required');
  }
  if (filter.sourceGeneration && filter.excludeSourceGeneration) {
    throw new Error('RAG maintenance generation filters are mutually exclusive');
  }
  const params: Record<string, string> = {
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
  };
  const clauses = [
    'tenant_id = @tenantId',
    'workspace_id = @workspaceId',
    `scope LIKE 'rag:%'`,
  ];
  if (filter.scopeFingerprint) {
    params.scopeFingerprint = filter.scopeFingerprint;
    clauses.push('rag_scope_fingerprint = @scopeFingerprint');
  }
  if (filter.codebaseId) {
    params.ownerId = filter.codebaseId;
    clauses.push('rag_codebase_id = @ownerId');
    clauses.push(`rag_registry_origin = 'codebase_registry'`);
  } else {
    params.ownerId = filter.knowledgeSourceId!;
    clauses.push('rag_knowledge_source_id = @ownerId');
    clauses.push(`rag_registry_origin = 'external_knowledge_registry'`);
  }
  if (filter.sourceGeneration) {
    params.sourceGeneration = filter.sourceGeneration;
    clauses.push('rag_source_generation = @sourceGeneration');
  }
  if (filter.excludeSourceGeneration) {
    params.excludeSourceGeneration = filter.excludeSourceGeneration;
    clauses.push(`COALESCE(rag_source_generation, '') <> @excludeSourceGeneration`);
  }
  return {where: clauses.join('\n AND '), params};
}

/** Count one private owner/generation entirely in SQLite. */
export function countScopedRagRecords(
  scopeInput: KnowledgeScope | undefined,
  filter: ScopedRagMaintenanceFilter,
): number {
  const scope = resolveKnowledgeScope(scopeInput);
  return withKnowledgeDb((db) => {
    const {where, params} = scopedRagMaintenanceWhere(scope, filter);
    return db.prepare<unknown[], {count: number}>(`
      SELECT COUNT(*) AS count FROM memory_entries WHERE ${where}
    `).get(params)?.count ?? 0;
  });
}

export interface ScopedRagStatsRow {
  kind: string;
  chunkCount: number;
  lastIndexedAt?: number;
}

/** Aggregate authorized RAG stats in SQLite without materializing chunk JSON. */
export function getScopedRagStats(
  scopeInput?: KnowledgeScope,
  scopeFingerprint?: string,
): ScopedRagStatsRow[] {
  const scope = resolveKnowledgeScope(scopeInput);
  return withKnowledgeDb((db) => db.prepare<unknown[], {
    kind: string;
    chunk_count: number;
    last_indexed_at: number | null;
  }>(`
    SELECT
      substr(scope, 5) AS kind,
      COUNT(*) AS chunk_count,
      MAX(CAST(json_extract(content_json, '$.record.indexedAt') AS INTEGER)) AS last_indexed_at
    FROM memory_entries
    WHERE tenant_id = @tenantId
      AND workspace_id = @workspaceId
      AND scope LIKE 'rag:%'
      AND NOT ${RETIRED_RAG_CHUNK_SQL}
      AND (
        (
          scope <> 'rag:android_internals_wiki'
          AND COALESCE(rag_registry_origin, '') <> 'codebase_registry'
        )
        OR (
          @scopeFingerprint IS NOT NULL
          AND rag_scope_fingerprint = @scopeFingerprint
        )
      )
    GROUP BY scope
  `).all({
    tenantId: scope.tenantId,
    workspaceId: scope.workspaceId,
    scopeFingerprint: scopeFingerprint ?? null,
  }).map(row => ({
    kind: row.kind,
    chunkCount: row.chunk_count,
    ...(row.last_indexed_at === null ? {} : {lastIndexedAt: row.last_indexed_at}),
  })));
}

/** Delete stale private generations without materializing their JSON in JS. */
export function removeScopedRagRecords(
  scopeInput: KnowledgeScope | undefined,
  filter: ScopedRagMaintenanceFilter,
): number {
  const scope = resolveKnowledgeScope(scopeInput);
  return withKnowledgeDb((db) => {
    const {where, params} = scopedRagMaintenanceWhere(scope, filter);
    const tx = db.transaction(() => {
      db.prepare(`
        DELETE FROM rag_knowledge_fts
        WHERE entry_id IN (SELECT id FROM memory_entries WHERE ${where})
      `).run(params);
      return db.prepare(`DELETE FROM memory_entries WHERE ${where}`).run(params).changes;
    });
    return tx.immediate();
  });
}

export function listScopedKnowledgeRecords<T>(
  kind: string,
  scopeInput?: KnowledgeScope,
  opts: ListOptions = {},
): ScopedKnowledgeRecord<T>[] {
  const scope = resolveKnowledgeScope(scopeInput);
  return withKnowledgeDb((db) => {
    const params: Record<string, string> = {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      systemTenantId: 'system',
      systemWorkspaceId: 'system',
    };
    const ownerClause = opts.includeSystem
      ? `((tenant_id = @tenantId AND workspace_id = @workspaceId)
          OR (tenant_id = @systemTenantId AND workspace_id = @systemWorkspaceId))`
      : `(tenant_id = @tenantId AND workspace_id = @workspaceId)`;
    let scopeClause = '';
    if (opts.rowScope !== undefined) {
      params.rowScope = opts.rowScope;
      scopeClause = 'AND scope = @rowScope';
    } else if (opts.rowScopePrefix !== undefined) {
      params.rowScopePrefix = `${opts.rowScopePrefix}%`;
      scopeClause = 'AND scope LIKE @rowScopePrefix';
    }
    const rows = db.prepare<unknown[], KnowledgeEntryRow>(`
      SELECT *
      FROM memory_entries
      WHERE ${ownerClause}
        ${scopeClause}
      ORDER BY updated_at DESC, id ASC
    `).all(params);
    return rows
      .map(row => {
        const record = parseKnowledgeRow<T>(kind, row);
        if (!record && opts.requireReadable) throw new Error('knowledge_record_unreadable');
        return record;
      })
      .filter((record): record is ScopedKnowledgeRecord<T> => Boolean(record));
  });
}

/**
 * Retrieve a bounded enterprise RAG candidate set. Authorization/generation
 * filters execute in SQLite before FTS candidates cross into JavaScript.
 */
export function searchScopedRagKnowledgeRecords<T>(
  kind: string,
  scopeInput: KnowledgeScope | undefined,
  opts: ScopedRagSearchOptions,
): ScopedRagSearchResult<T> {
  const scope = resolveKnowledgeScope(scopeInput);
  return withKnowledgeDb((db) => {
    const params: Record<string, string | number> = {
      tenantId: scope.tenantId,
      workspaceId: scope.workspaceId,
      systemTenantId: 'system',
      systemWorkspaceId: 'system',
    };
    const ownerClause = opts.includeSystem
      ? `((memory_entries.tenant_id = @tenantId AND memory_entries.workspace_id = @workspaceId)
          OR (memory_entries.tenant_id = @systemTenantId AND memory_entries.workspace_id = @systemWorkspaceId))`
      : `(memory_entries.tenant_id = @tenantId AND memory_entries.workspace_id = @workspaceId)`;
    // Retired case chunks are not part of the index: a store holding only
    // them reads as empty, and they never take a candidate slot below.
    const indexClauses = [ownerClause, `memory_entries.scope LIKE 'rag:%'`, `NOT ${RETIRED_RAG_CHUNK_SQL}`];
    const eligibleClauses = [...indexClauses, 'memory_entries.rag_unsupported_reason IS NULL'];

    if (opts.rowScopes && opts.rowScopes.length > 0) {
      const placeholders = opts.rowScopes.map((rowScope, index) => {
        const name = `rowScope${index}`;
        params[name] = rowScope;
        return `@${name}`;
      });
      eligibleClauses.push(`memory_entries.scope IN (${placeholders.join(', ')})`);
    } else if (opts.rowScopes?.length === 0) {
      eligibleClauses.push('0');
    }

    const addGenerationPairs = (
      column: 'rag_codebase_id' | 'rag_knowledge_source_id',
      pairs: readonly ScopedRagGenerationPair[] | undefined,
      prefix: string,
      allowLegacyDefault: boolean,
    ): void => {
      if (!pairs || pairs.length === 0 || !opts.scopeFingerprint) {
        eligibleClauses.push('0');
        return;
      }
      params.scopeFingerprint = opts.scopeFingerprint;
      const pairClauses = pairs.map((pair, index) => {
        const idName = `${prefix}Id${index}`;
        const generationName = `${prefix}Generation${index}`;
        params[idName] = pair.id;
        params[generationName] = pair.generation;
        const generationClause = allowLegacyDefault
          ? `(memory_entries.rag_source_generation = @${generationName}
              OR (memory_entries.rag_source_generation IS NULL AND @${generationName} = 'codebase_1'))`
          : `memory_entries.rag_source_generation = @${generationName}`;
        return `(memory_entries.${column} = @${idName} AND ${generationClause})`;
      });
      eligibleClauses.push(`(${pairClauses.join(' OR ')})`);
      eligibleClauses.push('memory_entries.rag_scope_fingerprint = @scopeFingerprint');
    };

    if (opts.selection === 'codebase') {
      addGenerationPairs('rag_codebase_id', opts.codebaseGenerations, 'codebase', true);
    } else if (opts.selection === 'knowledge') {
      addGenerationPairs(
        'rag_knowledge_source_id',
        opts.knowledgeSourceGenerations,
        'knowledge',
        false,
      );
    } else if (opts.selection === 'public') {
      eligibleClauses.push(`COALESCE(memory_entries.rag_registry_origin, '') NOT IN (
        'codebase_registry', 'external_knowledge_registry'
      )`);
      eligibleClauses.push(`memory_entries.scope <> 'rag:android_internals_wiki'`);
    } else {
      eligibleClauses.push('0');
    }

    const addExact = (column: string, value: string | undefined, name: string): void => {
      if (!value) return;
      params[name] = value;
      eligibleClauses.push(`memory_entries.${column} = @${name}`);
    };
    addExact('rag_vendor', opts.vendor, 'vendor');
    addExact('rag_build_id', opts.buildId, 'buildId');
    addExact('rag_symbol', opts.symbolExact, 'symbolExact');
    addExact('rag_lookup_path', opts.filePathExact, 'filePathExact');
    if (opts.pathPrefix) {
      params.pathPrefix = `${escapeSqlLikeLiteral(opts.pathPrefix)}%`;
      eligibleClauses.push(`memory_entries.rag_lookup_path LIKE @pathPrefix ESCAPE '\\'`);
    }
    if (opts.languages && opts.languages.length > 0) {
      const placeholders = opts.languages.map((language, index) => {
        const name = `language${index}`;
        params[name] = language;
        return `@${name}`;
      });
      eligibleClauses.push(`memory_entries.rag_language IN (${placeholders.join(', ')})`);
    } else if (opts.languages?.length === 0) {
      eligibleClauses.push('0');
    }

    const hasRows = (clauses: readonly string[]): boolean => Boolean(
      db.prepare<unknown[], {present: number}>(`
        SELECT EXISTS(
          SELECT 1
          FROM memory_entries
          WHERE ${clauses.join('\n AND ')}
          LIMIT 1
        ) AS present
      `).get(params)?.present,
    );
    const indexHasRows = hasRows(indexClauses);
    const eligibleHasRows = hasRows(eligibleClauses);
    if (!eligibleHasRows) return {records: [], indexHasRows, eligibleHasRows};

    const candidateLimit = Math.max(1, Math.min(2_000, opts.candidateLimit ?? 500));
    params.candidateLimit = candidateLimit;
    const exactLocation = Boolean(opts.symbolExact || opts.filePathExact || opts.pathPrefix);
    let rows: KnowledgeEntryRow[] = [];
    if (exactLocation) {
      rows = db.prepare<unknown[], KnowledgeEntryRow>(`
        SELECT memory_entries.*
        FROM memory_entries
        WHERE ${eligibleClauses.join('\n AND ')}
        ORDER BY memory_entries.updated_at DESC, memory_entries.id ASC
        LIMIT @candidateLimit
      `).all(params);
    } else {
      const queryTokens = Array.from(new Set(opts.queryTokens ?? []));
      if (queryTokens.length > 0) {
        params.ftsQuery = queryTokens
          .map(token => `"${token.replace(/"/g, '""')}"`)
          .join(' OR ');
        rows = db.prepare<unknown[], KnowledgeEntryRow>(`
          SELECT memory_entries.*
          FROM rag_knowledge_fts
          JOIN memory_entries ON memory_entries.id = rag_knowledge_fts.entry_id
          WHERE rag_knowledge_fts.search_tokens MATCH @ftsQuery
            AND ${eligibleClauses.join('\n AND ')}
          ORDER BY bm25(rag_knowledge_fts), memory_entries.updated_at DESC
          LIMIT @candidateLimit
        `).all(params);

        // Old binaries cannot run the application tokenizer. Migration
        // triggers mark their writes as legacy_pending and remove stale FTS
        // entries; include a bounded set here so the existing JavaScript scorer
        // applies the same Han-bigram/camelCase semantics as canonical rows.
        const pendingRows = db.prepare<unknown[], KnowledgeEntryRow>(`
          SELECT memory_entries.*
          FROM memory_entries
          WHERE memory_entries.rag_index_state = 'legacy_pending'
            AND ${eligibleClauses.join('\n AND ')}
          ORDER BY memory_entries.updated_at DESC, memory_entries.id ASC
          LIMIT @candidateLimit
        `).all(params);
        const seen = new Set(rows.map(row => row.id));
        for (const row of pendingRows) {
          if (seen.has(row.id)) continue;
          rows.push(row);
          seen.add(row.id);
          if (rows.length >= candidateLimit) break;
        }
      }
    }
    return {
      records: rows
        .map(row => parseKnowledgeRow<T>(kind, row))
        .filter((record): record is ScopedKnowledgeRecord<T> => Boolean(record)),
      indexHasRows,
      eligibleHasRows,
    };
  });
}

function withKnowledgeDb<T>(
  fn: (db: Database.Database) => T,
  db: Database.Database = openEnterpriseDb(),
): T {
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Undefined for a read-only read when no database exists yet. */
function readKnowledgeDb<T>(
  opts: KnowledgeReadOptions,
  fn: (db: Database.Database) => T,
): T | undefined {
  if (!opts.readOnly) return withKnowledgeDb(fn);
  const db = openEnterpriseDbReadOnly();
  return db ? withKnowledgeDb(fn, db) : undefined;
}

function mutateScopedKnowledgeRecordInDb<T>(
  db: Database.Database,
  scope: ResolvedKnowledgeScope,
  mutation: ScopedKnowledgeMutation<T>,
): T {
  const repo = createEnterpriseWorkspaceRepository<KnowledgeEntryRow>(
    db,
    'memory_entries',
  );
  const rowId = scopedKnowledgeRowId(mutation.kind, mutation.externalId, scope);
  const existing = repo.getById(scope, rowId);
  const current = existing
    ? parseKnowledgeRow<T>(mutation.kind, existing)?.record
    : undefined;
  const record = mutation.mutate(current);
  const now = mutation.options.updatedAt ?? Date.now();
  const sourceRunId = resolveSourceRunId(
    db,
    mutation.options.sourceRunId || scope.sourceRunId,
  );
  const envelope: KnowledgeEnvelope<T> = {
    schemaVersion: 1,
    kind: mutation.kind,
    externalId: mutation.externalId,
    sourceTenantId: scope.tenantId,
    sourceWorkspaceId: scope.workspaceId,
    ...(sourceRunId ? {sourceRunId} : {}),
    record,
  };
  const updateValues = {
    scope: mutation.options.rowScope,
    source_run_id: sourceRunId,
    content_json: JSON.stringify(envelope),
    embedding_ref: mutation.options.embeddingRef ?? null,
    ...ragIndexColumnValues(mutation.kind, record),
    rag_index_state: mutation.kind === 'rag_chunk' ? 'token_v1' : null,
    rag_indexed_updated_at: mutation.kind === 'rag_chunk' ? now : null,
    updated_at: now,
  };
  const changes = existing
    ? repo.updateById(scope, rowId, updateValues)
    : repo.upsertById(scope, rowId, {
      ...updateValues,
      created_at: mutation.options.createdAt ?? now,
    });
  if (changes === 0) {
    throw new Error('Knowledge entry id already exists outside the repository scope');
  }
  syncRagFts(db, rowId, scope, mutation.options.rowScope, mutation.kind, record);
  return record;
}

function upsertScopedKnowledgeRecordInDb<T>(
  db: Database.Database,
  repo: ReturnType<typeof createEnterpriseWorkspaceRepository<KnowledgeEntryRow>>,
  scope: ResolvedKnowledgeScope,
  entry: ScopedKnowledgeUpsert<T>,
): void {
  const options = entry.options ?? {};
  const now = Date.now();
  const sourceRunId = resolveSourceRunId(
    db,
    options.sourceRunId || scope.sourceRunId,
  );
  const envelope: KnowledgeEnvelope<T> = {
    schemaVersion: 1,
    kind: entry.kind,
    externalId: entry.externalId,
    sourceTenantId: scope.tenantId,
    sourceWorkspaceId: scope.workspaceId,
    ...(sourceRunId ? {sourceRunId} : {}),
    record: entry.record,
  };
  const updateValues = {
    scope: entry.rowScope,
    source_run_id: sourceRunId,
    content_json: JSON.stringify(envelope),
    embedding_ref: options.embeddingRef ?? null,
    ...ragIndexColumnValues(entry.kind, entry.record),
    rag_index_state: entry.kind === 'rag_chunk' ? 'token_v1' : null,
    rag_indexed_updated_at: entry.kind === 'rag_chunk'
      ? options.updatedAt ?? now
      : null,
    updated_at: options.updatedAt ?? now,
  };
  const rowId = scopedKnowledgeRowId(entry.kind, entry.externalId, scope);
  const existing = repo.getById(scope, rowId);
  const changes = existing
    ? repo.updateById(scope, rowId, updateValues)
    : repo.upsertById(scope, rowId, {
        ...updateValues,
        created_at: options.createdAt ?? now,
      });
  if (changes === 0) {
    throw new Error('Knowledge entry id already exists outside the repository scope');
  }
  syncRagFts(db, rowId, scope, entry.rowScope, entry.kind, entry.record);
}

function ragRecord(record: unknown): Record<string, unknown> | undefined {
  return record && typeof record === 'object' && !Array.isArray(record)
    ? record as Record<string, unknown>
    : undefined;
}

function ragIndexColumnValues(kind: string, recordValue: unknown): Record<string, string | null> {
  const record = kind === 'rag_chunk' ? ragRecord(recordValue) : undefined;
  const text = (key: string): string | null => typeof record?.[key] === 'string'
    ? record[key] as string
    : null;
  return {
    rag_registry_origin: text('registryOrigin'),
    rag_codebase_id: text('codebaseId'),
    rag_knowledge_source_id: text('knowledgeSourceId'),
    rag_source_generation: text('sourceGeneration'),
    rag_scope_fingerprint: text('knowledgeScopeFingerprint'),
    rag_unsupported_reason: text('unsupportedReason'),
    rag_vendor: text('vendor'),
    rag_build_id: text('buildId'),
    rag_language: text('language'),
    rag_symbol: text('symbol'),
    rag_lookup_path: text('filePath') ?? text('uri'),
  };
}

function syncRagFts(
  db: Database.Database,
  rowId: string,
  scope: ResolvedKnowledgeScope,
  rowScope: string,
  kind: string,
  recordValue: unknown,
): void {
  db.prepare('DELETE FROM rag_knowledge_fts WHERE entry_id = ?').run(rowId);
  const record = kind === 'rag_chunk' ? ragRecord(recordValue) : undefined;
  if (!record) return;
  db.prepare(`
    INSERT INTO rag_knowledge_fts(entry_id, tenant_id, workspace_id, scope, search_tokens)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    rowId,
    scope.tenantId,
    scope.workspaceId,
    rowScope,
    buildRagSearchTokenText(record),
  );
  db.prepare(`
    UPDATE memory_entries
    SET rag_index_state = 'token_v1',
        rag_indexed_updated_at = updated_at
    WHERE id = ?
  `).run(rowId);
}

function sanitizeScopeSegment(value: string, label: string): string {
  if (!SAFE_SCOPE_SEGMENT_RE.test(value) || value === '.' || value === '..') {
    throw new Error(`Unsafe knowledge ${label}: ${value}`);
  }
  return value;
}

function ensureEnterpriseKnowledgeGraph(
  db: Database.Database,
  scope: ResolvedKnowledgeScope,
): void {
  const now = Date.now();
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
      `${scope.userId}@knowledge.local`,
      scope.userId,
      `knowledge:${scope.userId}`,
      now,
      now,
    );
  }
}

function resolveSourceRunId(
  db: Database.Database,
  sourceRunId?: string,
): string | null {
  if (!sourceRunId) return null;
  const row = db.prepare<unknown[], {id: string}>(`
    SELECT id
    FROM analysis_runs
    WHERE id = ?
    LIMIT 1
  `).get(sourceRunId);
  return row ? sourceRunId : null;
}

function parseKnowledgeRow<T>(
  kind: string,
  row: KnowledgeEntryRow,
): ScopedKnowledgeRecord<T> | undefined {
  try {
    const parsed = JSON.parse(row.content_json) as KnowledgeEnvelope<T>;
    if (
      parsed.schemaVersion !== 1 ||
      parsed.kind !== kind ||
      parsed.externalId === undefined
    ) {
      return undefined;
    }
    return {
      externalId: parsed.externalId,
      rowScope: row.scope,
      record: parsed.record,
      ...(row.source_run_id ? {sourceRunId: row.source_run_id} : {}),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  } catch {
    return undefined;
  }
}
