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
 *   (the former Android Internals Wiki chunks), or a kind or origin this build
 *   does not recognize. Visible only in its owner scope for listing and
 *   deletion; never served, exported or written again.
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
/** Origins the public corpora are written with; absent on chunks written before origins existed. */
const PUBLIC_ORIGINS: readonly string[] = ['', 'legacy_plan55', 'plan44_memory', 'plan54_cases'];
const USER_CODEBASE_KINDS: readonly string[] = ['app_source', 'kernel_source'];
const USER_CODEBASE_ORIGIN = 'codebase_registry';

function hasCodebaseId(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/** An absent origin reads as ''; one that is not a string matches no origin. */
function originOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : undefined;
}

/**
 * Closed in both directions: `public` only for a public kind written with a
 * public origin and no codebase id, `user_codebase` only for codebase
 * material, and everything else (a retired connector's kind or origin, or
 * anything this build does not recognize) `retired_private`.
 */
export function ragChunkAudience(chunk: RagChunkAudienceFacts): RagChunkAudience {
  const kind = typeof chunk.kind === 'string' ? chunk.kind : '';
  const origin = originOf(chunk.registryOrigin);
  const codebaseId = hasCodebaseId(chunk.codebaseId);
  const publicKind = PUBLIC_RAG_KINDS.includes(kind);
  const userCodebaseKind = USER_CODEBASE_KINDS.includes(kind);
  if (publicKind && origin !== undefined && PUBLIC_ORIGINS.includes(origin) && !codebaseId) return 'public';
  if ((publicKind || userCodebaseKind) && (origin === '' || origin === USER_CODEBASE_ORIGIN) &&
    (userCodebaseKind || origin === USER_CODEBASE_ORIGIN || codebaseId)) {
    return 'user_codebase';
  }
  return 'retired_private';
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
    AND COALESCE(${columns.registryOrigin}, '') IN (${sqlList(PUBLIC_ORIGINS)})
    AND COALESCE(${columns.codebaseId}, '') = '')`;
}
