// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * Who a RAG chunk may be shown to: the single classification every RAG
 * reader and writer uses, in JavaScript (`ragChunkAudience`) and in SQL over
 * the enterprise knowledge rows (`ragPublicAudienceSql`).
 *
 * - `public`: legacy public corpora (blog, operator-ingested AOSP/OEM docs,
 *   memory and case corpora). Visible in every scope, served with its text.
 * - `user_codebase`: a user's registered codebase material. Visible only in
 *   the owner scope that indexed it, served only through the codebase
 *   registry's selection, consent and redaction.
 * - `retired_private`: registered private knowledge from a retired connector
 *   (the former Android Internals Wiki chunks and Pack), or a kind or origin
 *   this build does not recognize. Visible only in its owner scope for
 *   listing and deletion; never served, exported or written again.
 *
 * Document knowledge bases are not RAG chunks at all: they live in their own
 * SQLite FTS generations (`services/knowledge/`).
 */

export type RagChunkAudience = 'public' | 'user_codebase' | 'retired_private';

/** The facts the classification reads; sanitized hit metadata carries no origin. */
export interface RagChunkAudienceFacts {
  kind?: unknown;
  registryOrigin?: unknown;
  codebaseId?: unknown;
}

/** Row scope prefix of RAG chunks in the enterprise knowledge store (`rag:<kind>`). */
export const RAG_ROW_SCOPE_PREFIX = 'rag:';

const PUBLIC_RAG_KINDS: readonly string[] = [
  'androidperformance.com',
  'aosp',
  'oem_sdk',
  'project_memory',
  'world_memory',
  'case_library',
];
const USER_CODEBASE_KINDS: readonly string[] = ['app_source', 'kernel_source'];
const USER_CODEBASE_ORIGIN = 'codebase_registry';
/** Origins of retired private connectors; no current writer sets them. */
const RETIRED_PRIVATE_ORIGINS: readonly string[] = ['external_knowledge_registry', 'built_in_knowledge_pack'];

function hasCodebaseId(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

export function ragChunkAudience(chunk: RagChunkAudienceFacts): RagChunkAudience {
  const kind = typeof chunk.kind === 'string' ? chunk.kind : '';
  const origin = typeof chunk.registryOrigin === 'string' ? chunk.registryOrigin : '';
  const userCodebaseKind = USER_CODEBASE_KINDS.includes(kind);
  if ((!PUBLIC_RAG_KINDS.includes(kind) && !userCodebaseKind) || RETIRED_PRIVATE_ORIGINS.includes(origin)) {
    return 'retired_private';
  }
  if (userCodebaseKind || origin === USER_CODEBASE_ORIGIN || hasCodebaseId(chunk.codebaseId)) {
    return 'user_codebase';
  }
  return 'public';
}

function sqlList(values: readonly string[]): string {
  return values.map(value => `'${value.replace(/'/g, "''")}'`).join(', ');
}

/**
 * SQL that holds exactly when `ragChunkAudience` of the row is `public`.
 * The arguments name the row's scope (`rag:<kind>`), registry-origin and
 * codebase-id columns.
 */
export function ragPublicAudienceSql(columns: {scope: string; registryOrigin: string; codebaseId: string}): string {
  const publicScopes = PUBLIC_RAG_KINDS.map(kind => `${RAG_ROW_SCOPE_PREFIX}${kind}`);
  return `(${columns.scope} IN (${sqlList(publicScopes)})
    AND COALESCE(${columns.registryOrigin}, '') NOT IN (${sqlList([USER_CODEBASE_ORIGIN, ...RETIRED_PRIVATE_ORIGINS])})
    AND COALESCE(${columns.codebaseId}, '') = '')`;
}
