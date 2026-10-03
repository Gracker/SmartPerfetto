// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

import Database from 'better-sqlite3';

import type {
  RagChunk,
  RagRetrievalHit,
  RagRetrievalResult,
} from '../../types/sparkContracts';
import {
  knowledgeBm25,
  knowledgeFtsMatchExpression,
  knowledgeQueryTokens,
  normalizeKnowledgeQuery,
} from '../knowledge/knowledgeTokens';
import {
  ANDROID_INTERNALS_PACK_LICENSE,
  type AndroidInternalsPackHandle,
  type AndroidInternalsPackSearchOptions,
  type AndroidInternalsPackStoreLike,
} from './types';

const REQUIRED_TABLES = [
  'articles',
  'chunks',
  'chunks_fts',
  'pack_manifest',
  'sections',
  'sources',
] as const;
const MAX_TOP_K = 20;

interface SearchRow {
  chunk_id: string;
  article_id: string;
  section_id: string;
  title: string;
  relative_path: string;
  confidence: string | null;
  last_verified: string | null;
  last_verified_against: string | null;
  heading: string;
  body: string;
  start_line: number;
  end_line: number;
  chunk_hash: string;
  token_count: number;
  rank: number;
}

function manifestValue(db: Database.Database, key: string): unknown {
  const row = db.prepare('SELECT value FROM pack_manifest WHERE key = ?').get(key) as
    {value?: unknown} | undefined;
  if (!row || typeof row.value !== 'string') throw new Error(`aiw_pack_manifest_missing_${key}`);
  return JSON.parse(row.value);
}

function validateDatabase(db: Database.Database, handle: AndroidInternalsPackHandle): void {
  const quickCheck = db.pragma('quick_check', {simple: true});
  if (quickCheck !== 'ok') throw new Error('aiw_pack_sqlite_quick_check_failed');
  const tables = new Set(
    (db.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')",
    ).all() as Array<{name: string}>).map(row => row.name),
  );
  for (const table of REQUIRED_TABLES) {
    if (!tables.has(table)) throw new Error(`aiw_pack_missing_table_${table}`);
  }
  const userVersion = db.pragma('user_version', {simple: true});
  if (userVersion !== 1) throw new Error('aiw_pack_unsupported_sqlite_schema');
  const internalIdentity = {
    packId: manifestValue(db, 'packId'),
    contentVersion: manifestValue(db, 'contentVersion'),
    contentFingerprint: manifestValue(db, 'contentFingerprint'),
    sourceRevision: manifestValue(db, 'sourceRevision'),
    packFormatVersion: manifestValue(db, 'packFormatVersion'),
    licenseExpression: manifestValue(db, 'licenseExpression'),
  };
  if (
    internalIdentity.packId !== handle.manifest.packId ||
    internalIdentity.contentVersion !== handle.contentVersion ||
    internalIdentity.contentFingerprint !== handle.contentFingerprint ||
    internalIdentity.sourceRevision !== handle.sourceRevision ||
    internalIdentity.packFormatVersion !== handle.manifest.packFormatVersion ||
    internalIdentity.licenseExpression !== handle.manifest.licenses.expression
  ) {
    throw new Error('aiw_pack_internal_manifest_mismatch');
  }
  const counts = db.prepare(`
    SELECT
      (SELECT count(*) FROM articles) AS article_count,
      (SELECT count(*) FROM sections) AS section_count,
      (SELECT count(*) FROM chunks) AS chunk_count
  `).get() as {article_count: number; section_count: number; chunk_count: number};
  if (
    counts.article_count !== handle.manifest.articleCount ||
    counts.section_count !== handle.manifest.sectionCount ||
    counts.chunk_count !== handle.manifest.chunkCount
  ) {
    throw new Error('aiw_pack_count_mismatch');
  }
}

export class AndroidInternalsPackStore implements AndroidInternalsPackStoreLike {
  private readonly db: Database.Database;
  private closed = false;

  constructor(readonly handle: AndroidInternalsPackHandle) {
    this.db = new Database(handle.databasePath, {readonly: true, fileMustExist: true});
    this.db.pragma('query_only = ON');
    this.db.pragma('busy_timeout = 5000');
    try {
      validateDatabase(this.db, handle);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  search(query: string, options: AndroidInternalsPackSearchOptions = {}): RagRetrievalResult {
    if (this.closed) throw new Error('aiw_pack_store_closed');
    const boundedQuery = normalizeKnowledgeQuery(query);
    const tokens = knowledgeQueryTokens(boundedQuery);
    const topK = Math.min(MAX_TOP_K, Math.max(1, Math.trunc(options.topK ?? 5)));
    if (!boundedQuery || tokens.length === 0) {
      return this.result(boundedQuery, [], 'empty_query');
    }
    // Tokens with no letter or digit match nothing; with none left there is no hit.
    const expression = knowledgeFtsMatchExpression(tokens);
    const rows = !expression ? [] : this.db.prepare(`
      SELECT
        c.chunk_id,
        c.article_id,
        c.section_id,
        a.title,
        a.relative_path,
        a.confidence,
        a.last_verified,
        a.last_verified_against,
        c.heading,
        c.body,
        c.start_line,
        c.end_line,
        c.chunk_hash,
        c.token_count,
        ${knowledgeBm25('chunks_fts', 1)} AS rank
      FROM chunks_fts
      JOIN chunks c ON c.chunk_id = chunks_fts.chunk_id
      JOIN articles a ON a.article_id = c.article_id
      WHERE chunks_fts MATCH ?
      ORDER BY rank ASC, c.chunk_id ASC
      LIMIT ?
    `).all(expression, topK) as SearchRow[];
    const hits: RagRetrievalHit[] = rows.map((row, index) => ({
      chunkId: row.chunk_id,
      score: 1 / (index + 1),
      chunk: this.toChunk(row),
    }));
    return this.result(
      boundedQuery,
      hits,
      hits.length === 0 ? 'no_matching_background_knowledge' : undefined,
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }

  private toChunk(row: SearchRow): RagChunk {
    return {
      chunkId: row.chunk_id,
      kind: 'android_internals_pack',
      registryOrigin: 'built_in_knowledge_pack',
      uri: `aiw-pack://${this.handle.contentVersion}/${row.relative_path}`,
      title: row.title,
      snippet: row.body,
      tokenCount: row.token_count,
      license: ANDROID_INTERNALS_PACK_LICENSE,
      attribution: this.handle.manifest.licenses.attribution,
      indexedAt: Date.parse(this.handle.manifest.generatedAt),
      verifiedAt: row.last_verified ? Date.parse(row.last_verified) : undefined,
      sourceConfidence: row.confidence ?? undefined,
      lastVerifiedAgainst: row.last_verified_against ?? undefined,
      lineRange: {start: row.start_line, end: row.end_line},
      commitHash: this.handle.sourceRevision,
      commitProvenance: 'clean_git_revision',
      contentFingerprint: this.handle.contentFingerprint,
      articleId: row.article_id,
      sectionId: row.section_id,
      sectionHeading: row.heading,
      chunkHash: row.chunk_hash,
      knowledgePackVersion: this.handle.contentVersion,
      knowledgePackFingerprint: this.handle.contentFingerprint,
    };
  }

  private result(
    query: string,
    results: RagRetrievalHit[],
    unsupportedReason?: string,
  ): RagRetrievalResult {
    const now = Date.now();
    return {
      schemaVersion: 1,
      source: `android-internals-pack:${this.handle.contentVersion}`,
      createdAt: now,
      query,
      results,
      probed: ['android_internals_pack'],
      retrievedAt: now,
      ...(unsupportedReason ? {unsupportedReason} : {}),
    };
  }
}
