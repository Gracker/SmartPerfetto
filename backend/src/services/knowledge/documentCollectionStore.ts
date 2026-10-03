// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * One SQLite FTS5 file per document-collection generation, under the user
 * data directory: `knowledge/<scope hash>/<source id>/<generation>.sqlite`.
 * Every path segment is a server-generated id, checked here before use.
 *
 * A generation is written to a `.staging` file and renamed into place whole;
 * the registry pointer (`activateGeneration`) makes it current. Readers open
 * a generation read-only and check its manifest names the exact source,
 * scope and generation they asked for. The index is instance-local: several
 * enterprise instances must share the data volume.
 *
 * Deleting files is fenced by the caller's lease: every destructive batch
 * first checks it still owns the source, and stops at once when it does not,
 * since another instance may by then be writing its own staging file.
 */

import {createHash} from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import Database from 'better-sqlite3';

import {userDataPath} from '../../runtimePaths';
import {PublicRequestError} from '../../utils/publicRequestError';
import {logStoredReadFailure, tryParseStoredJson} from '../../utils/storedData';
import {
  type ExternalKnowledgeScope,
  isExternalKnowledgeSourceId,
  type KnowledgeCleanupFence,
  scopeKey,
} from '../externalKnowledgeSourceRegistry';
import type {DocumentCollectionDocument, DocumentCollectionReadSummary} from './documentCollectionCorpus';
import {
  knowledgeBm25,
  knowledgeFtsMatchExpression,
  knowledgeIndexTokenText,
  knowledgeQueryTokens,
} from './knowledgeTokens';

const SCHEMA_VERSION = 1;
const GENERATION = /^dc_[0-9a-f]{32}$/;
const GENERATION_FILE = /^(dc_[0-9a-f]{32})\.sqlite(\.staging)?(?:-journal|-wal|-shm)?$/;
const REQUIRED_TABLES = ['chunks', 'chunks_fts', 'documents', 'manifest', 'sections'] as const;
const MAX_TOP_K = 20;
const SNIPPET_CHARS = 400;
const CLEANUP_BATCH_FILES = 16;
const READER_CACHE_LIMIT = 32;

/** A selected generation whose file is missing or not the one the registry names. */
export class KnowledgeIndexUnavailableError extends PublicRequestError {
  constructor() {
    super('knowledge_index_unavailable', 'The knowledge index is unavailable; reindex the source', 409);
  }
}

/** The file's device, inode, size and modification time; undefined when it does not exist. */
function fileIdentity(filePath: string): string | undefined {
  try {
    const stat = fs.statSync(filePath);
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return undefined;
    throw new KnowledgeIndexUnavailableError();
  }
}

export interface DocumentCollectionSearchHit {
  chunkId: string;
  sectionId: string;
  relativePath: string;
  title: string;
  heading: string;
  headingPath: string[];
  startLine: number;
  endLine: number;
  snippet: string;
}

/** One whole section of a generation, as indexed (already redacted). */
export interface DocumentCollectionSection {
  sectionId: string;
  relativePath: string;
  title: string;
  heading: string;
  headingPath: string[];
  startLine: number;
  endLine: number;
  body: string;
}

/** The columns a search hit and a section read share. */
interface LocatedRow {
  section_id: string;
  relative_path: string;
  title: string;
  heading: string;
  heading_path_json: string;
  start_line: number;
  end_line: number;
  body: string;
}

interface SearchRow extends LocatedRow {
  chunk_id: string;
}

/** The fields both readers return; a heading path the index cannot read makes the index unavailable. */
function locatedFields(row: LocatedRow): Omit<DocumentCollectionSection, 'body'> {
  const headingPath = tryParseStoredJson<unknown>(row.heading_path_json, 'knowledge index heading path');
  if (!headingPath.ok || !Array.isArray(headingPath.value) ||
    !headingPath.value.every(heading => typeof heading === 'string')) {
    if (!headingPath.ok) logStoredReadFailure('[DocumentCollectionStore] unreadable heading path', headingPath.error,
      {sectionId: row.section_id});
    throw new KnowledgeIndexUnavailableError();
  }
  return {
    sectionId: row.section_id,
    relativePath: row.relative_path,
    title: row.title,
    heading: row.heading,
    headingPath: headingPath.value as string[],
    startLine: row.start_line,
    endLine: row.end_line,
  };
}

function scopeHash(scope: ExternalKnowledgeScope): string {
  return createHash('sha256').update(`document_collection\0${scopeKey(scope)}`).digest('hex').slice(0, 32);
}

function checkedId(value: string, valid: (value: string) => boolean): string {
  if (!valid(value)) throw new Error('knowledge_index_id_invalid');
  return value;
}

const isGenerationId = (value: string): boolean => GENERATION.test(value);

/** Staging files a writer in this process is still filling; GC never touches them. */
const stagingInProgress = new Set<string>();

function removeWithSidecars(filePath: string): void {
  for (const suffix of ['', '-journal', '-wal', '-shm']) fs.rmSync(`${filePath}${suffix}`, {force: true});
}

const SCHEMA = `
  CREATE TABLE manifest (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE documents (
    doc_id TEXT PRIMARY KEY,
    relative_path TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    content_hash TEXT NOT NULL
  );
  CREATE TABLE sections (
    section_id TEXT PRIMARY KEY,
    doc_id TEXT NOT NULL REFERENCES documents(doc_id),
    ordinal INTEGER NOT NULL,
    heading TEXT NOT NULL,
    heading_path_json TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    body TEXT NOT NULL
  );
  CREATE TABLE chunks (
    rowid INTEGER PRIMARY KEY,
    chunk_id TEXT NOT NULL UNIQUE,
    doc_id TEXT NOT NULL REFERENCES documents(doc_id),
    section_id TEXT NOT NULL REFERENCES sections(section_id),
    ordinal INTEGER NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    body TEXT NOT NULL,
    chunk_hash TEXT NOT NULL,
    token_count INTEGER NOT NULL
  );
  CREATE VIRTUAL TABLE chunks_fts USING fts5(
    title, heading, path, body, tokens,
    content = '', tokenize = 'unicode61'
  );
`;

interface GenerationIdentity {
  sourceId: string;
  scopeHash: string;
  generation: string;
}

/** Fills one staging file; `commit` renames it into place, `abort` deletes it. */
class DocumentCollectionGenerationWriter {
  private readonly db: Database.Database;
  private open = true;

  constructor(
    private readonly stagingPath: string,
    private readonly finalPath: string,
    private readonly identity: GenerationIdentity,
  ) {
    fs.mkdirSync(path.dirname(stagingPath), {recursive: true});
    removeWithSidecars(stagingPath);
    stagingInProgress.add(stagingPath);
    try {
      this.db = new Database(stagingPath);
      this.db.pragma('journal_mode = DELETE');
      this.db.exec(SCHEMA);
      this.db.pragma(`user_version = ${SCHEMA_VERSION}`);
    } catch (error) {
      stagingInProgress.delete(stagingPath);
      removeWithSidecars(stagingPath);
      throw error;
    }
  }

  /** One transaction per batch. The FTS table is contentless: it indexes the text the tables already hold. */
  writeBatch(documents: readonly DocumentCollectionDocument[]): void {
    if (!this.open) throw new Error('knowledge_index_writer_closed');
    const insertDocument = this.db.prepare(
      'INSERT INTO documents (doc_id, relative_path, title, content_hash) VALUES (?, ?, ?, ?)');
    const insertSection = this.db.prepare(`
      INSERT INTO sections (section_id, doc_id, ordinal, heading, heading_path_json, start_line, end_line, body)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertChunk = this.db.prepare(`
      INSERT INTO chunks (chunk_id, doc_id, section_id, ordinal, start_line, end_line, body, chunk_hash, token_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertFts = this.db.prepare(
      'INSERT INTO chunks_fts (rowid, title, heading, path, body, tokens) VALUES (?, ?, ?, ?, ?, ?)');
    this.db.transaction(() => {
      for (const document of documents) {
        const docId = `d${createHash('sha256').update(document.relativePath).digest('hex').slice(0, 16)}`;
        insertDocument.run(docId, document.relativePath, document.title, document.fileHash);
        for (const section of document.sections) {
          const sectionId = `${docId}:${section.ordinal}`;
          const headingPath = section.headingPath.join(' › ');
          insertSection.run(sectionId, docId, section.ordinal, section.heading,
            JSON.stringify(section.headingPath), section.startLine, section.endLine, section.body);
          for (const chunk of section.chunks) {
            const {lastInsertRowid} = insertChunk.run(`${sectionId}:${chunk.ordinal}`, docId, sectionId,
              chunk.ordinal, chunk.startLine, chunk.endLine, chunk.body,
              createHash('sha256').update(chunk.body).digest('hex'), Math.ceil(chunk.body.length / 4));
            insertFts.run(lastInsertRowid, document.title, headingPath, document.relativePath, chunk.body,
              knowledgeIndexTokenText(`${document.title}\n${headingPath}\n${document.relativePath}\n${chunk.body}`));
          }
        }
      }
    }).immediate();
  }

  /** Seal the manifest from the corpus summary and atomically move the file into place; the registry pointer is the caller's. */
  commit(summary: Pick<DocumentCollectionReadSummary,
    'contentFingerprint' | 'documentCount' | 'sectionCount' | 'chunkCount'>): void {
    if (!this.open) throw new Error('knowledge_index_writer_closed');
    const manifest: Record<string, string | number> = {
      schemaVersion: SCHEMA_VERSION,
      ...this.identity,
      contentFingerprint: summary.contentFingerprint,
      documentCount: summary.documentCount,
      sectionCount: summary.sectionCount,
      chunkCount: summary.chunkCount,
    };
    const insert = this.db.prepare('INSERT INTO manifest (key, value) VALUES (?, ?)');
    this.db.transaction(() => {
      for (const [key, value] of Object.entries(manifest)) insert.run(key, JSON.stringify(value));
    }).immediate();
    this.close();
    try {
      fs.renameSync(this.stagingPath, this.finalPath);
    } catch (error) {
      removeWithSidecars(this.stagingPath);
      throw error;
    }
  }

  abort(): void {
    if (this.open) this.close();
    removeWithSidecars(this.stagingPath);
  }

  private close(): void {
    this.open = false;
    stagingInProgress.delete(this.stagingPath);
    this.db.close();
  }
}

function readManifest(db: Database.Database): Map<string, unknown> {
  const manifest = new Map<string, unknown>();
  for (const row of db.prepare('SELECT key, value FROM manifest').all() as Array<{key: string; value: string}>) {
    // An unreadable value fails the identity check below.
    const value = tryParseStoredJson<unknown>(row.value, 'knowledge index manifest');
    if (value.ok) manifest.set(row.key, value.value);
  }
  return manifest;
}

const yieldEventLoop = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

export class DocumentCollectionStore {
  /** Validated read-only handles by generation path, with the file identity they were opened on; closed before that file is deleted. */
  private readonly readers = new Map<string, {db: Database.Database; identity: string}>();

  constructor(private readonly root: string = userDataPath('knowledge')) {}

  beginGeneration(
    scope: ExternalKnowledgeScope,
    sourceId: string,
    generation: string,
  ): DocumentCollectionGenerationWriter {
    const finalPath = this.generationPath(scope, sourceId, generation);
    return new DocumentCollectionGenerationWriter(`${finalPath}.staging`, finalPath, {
      sourceId,
      scopeHash: scopeHash(scope),
      generation,
    });
  }

  /** Delete one generation's file; a missing file is already deleted. */
  removeGeneration(
    scope: ExternalKnowledgeScope,
    sourceId: string,
    generation: string,
    fence: KnowledgeCleanupFence,
  ): void {
    const filePath = this.generationPath(scope, sourceId, generation);
    fence.assertHeld();
    this.closeReader(filePath);
    removeWithSidecars(filePath);
  }

  /**
   * Delete every file of a source in fenced batches. Throws when the fence
   * fails or a file cannot be removed, so the deletion can be retried.
   */
  async removeSource(scope: ExternalKnowledgeScope, sourceId: string, fence: KnowledgeCleanupFence): Promise<void> {
    const directory = this.sourceDirectory(scope, sourceId);
    const entries = this.listDirectory(directory);
    if (entries === undefined) return;
    await this.deleteInBatches(directory, entries, fence, filePath => fs.rmSync(filePath, {force: true}));
    fence.assertHeld();
    try {
      // Not recursive: a file that appeared since the listing fails this, and a retry deletes it.
      fs.rmdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  /**
   * Delete generations nobody references and staging files no writer in this
   * process is filling, in fenced batches. A file that cannot be deleted (an
   * open handle on Windows) waits for the next collection; a failed fence
   * stops the collection at once.
   */
  async collectGarbage(
    scope: ExternalKnowledgeScope,
    sourceId: string,
    keep: ReadonlySet<string>,
    fence: KnowledgeCleanupFence,
  ): Promise<{removed: number; failed: number}> {
    const directory = this.sourceDirectory(scope, sourceId);
    const victims = (this.listDirectory(directory) ?? []).filter(entry => {
      const match = GENERATION_FILE.exec(entry);
      if (!match) return false;
      return match[2]
        ? !stagingInProgress.has(path.join(directory, entry).replace(/-(?:journal|wal|shm)$/, ''))
        : !keep.has(match[1]!);
    });
    let removed = 0;
    let failed = 0;
    await this.deleteInBatches(directory, victims, fence, filePath => {
      try {
        fs.rmSync(filePath, {force: true});
        removed += 1;
      } catch {
        failed += 1;
      }
    });
    return {removed, failed};
  }

  search(
    scope: ExternalKnowledgeScope,
    sourceId: string,
    generation: string,
    query: string,
    topK: number,
  ): DocumentCollectionSearchHit[] {
    const expression = knowledgeFtsMatchExpression(knowledgeQueryTokens(query));
    if (!expression) return [];
    const limit = Math.min(MAX_TOP_K, Math.max(1, Math.trunc(topK)));
    const rows = this.reader(scope, sourceId, generation).prepare(`
      SELECT c.chunk_id, c.section_id, d.relative_path, d.title, s.heading, s.heading_path_json,
             c.start_line, c.end_line, c.body, ${knowledgeBm25('chunks_fts')} AS rank
      FROM chunks_fts
      JOIN chunks c ON c.rowid = chunks_fts.rowid
      JOIN sections s ON s.section_id = c.section_id
      JOIN documents d ON d.doc_id = c.doc_id
      WHERE chunks_fts MATCH ?
      ORDER BY rank ASC, c.chunk_id ASC
      LIMIT ?
    `).all(expression, limit) as SearchRow[];
    return rows.map(row => ({chunkId: row.chunk_id, ...locatedFields(row), snippet: row.body.slice(0, SNIPPET_CHARS)}));
  }

  /** The section a search hit belongs to, from the same pinned generation; undefined when it has none. */
  readSection(
    scope: ExternalKnowledgeScope,
    sourceId: string,
    generation: string,
    sectionId: string,
  ): DocumentCollectionSection | undefined {
    const row = this.reader(scope, sourceId, generation).prepare(`
      SELECT s.section_id, d.relative_path, d.title, s.heading, s.heading_path_json, s.start_line, s.end_line, s.body
      FROM sections s
      JOIN documents d ON d.doc_id = s.doc_id
      WHERE s.section_id = ?
    `).get(sectionId) as LocatedRow | undefined;
    return row ? {...locatedFields(row), body: row.body} : undefined;
  }

  private async deleteInBatches(
    directory: string,
    entries: readonly string[],
    fence: KnowledgeCleanupFence,
    remove: (filePath: string) => void,
  ): Promise<void> {
    for (let start = 0; start < entries.length; start += CLEANUP_BATCH_FILES) {
      await yieldEventLoop();
      fence.assertHeld();
      for (const entry of entries.slice(start, start + CLEANUP_BATCH_FILES)) {
        const filePath = path.join(directory, entry);
        this.closeReader(filePath);
        remove(filePath);
      }
    }
  }

  /** A directory that does not exist is already clean; any other failure is not, and propagates. */
  private listDirectory(directory: string): string[] | undefined {
    try {
      return fs.readdirSync(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private closeReader(filePath: string): void {
    const reader = this.readers.get(filePath);
    if (!reader) return;
    this.readers.delete(filePath);
    reader.db.close();
  }

  /** A cached read-only handle, opened after checking the file is the generation the registry names. */
  private reader(scope: ExternalKnowledgeScope, sourceId: string, generation: string): Database.Database {
    const filePath = this.generationPath(scope, sourceId, generation);
    // Another instance may delete or replace the file; a cached handle is
    // reused only while the file is still the one it was opened on.
    let identity: string | undefined;
    try {
      identity = fileIdentity(filePath);
    } catch (error) {
      // A file that cannot be checked holds no cached handle.
      this.closeReader(filePath);
      throw error;
    }
    const cached = this.readers.get(filePath);
    if (cached && cached.identity === identity) return cached.db;
    if (cached) this.closeReader(filePath);
    if (identity === undefined) throw new KnowledgeIndexUnavailableError();
    let db: Database.Database;
    try {
      db = new Database(filePath, {readonly: true, fileMustExist: true});
    } catch {
      throw new KnowledgeIndexUnavailableError();
    }
    try {
      db.pragma('query_only = ON');
      db.pragma('busy_timeout = 5000');
      const tables = new Set((db.prepare(
        "SELECT name FROM sqlite_master WHERE type IN ('table', 'view')",
      ).all() as Array<{name: string}>).map(row => row.name));
      if (
        db.pragma('user_version', {simple: true}) !== SCHEMA_VERSION ||
        REQUIRED_TABLES.some(table => !tables.has(table))
      ) {
        throw new KnowledgeIndexUnavailableError();
      }
      const manifest = readManifest(db);
      if (
        manifest.get('schemaVersion') !== SCHEMA_VERSION ||
        manifest.get('sourceId') !== sourceId ||
        manifest.get('scopeHash') !== scopeHash(scope) ||
        manifest.get('generation') !== generation
      ) {
        throw new KnowledgeIndexUnavailableError();
      }
    } catch (error) {
      db.close();
      throw error instanceof KnowledgeIndexUnavailableError ? error : new KnowledgeIndexUnavailableError();
    }
    if (this.readers.size >= READER_CACHE_LIMIT) {
      const [oldest] = this.readers.keys();
      if (oldest) this.closeReader(oldest);
    }
    this.readers.set(filePath, {db, identity});
    return db;
  }

  private sourceDirectory(scope: ExternalKnowledgeScope, sourceId: string): string {
    return path.join(this.root, scopeHash(scope), checkedId(sourceId, isExternalKnowledgeSourceId));
  }

  private generationPath(scope: ExternalKnowledgeScope, sourceId: string, generation: string): string {
    return path.join(this.sourceDirectory(scope, sourceId), `${checkedId(generation, isGenerationId)}.sqlite`);
  }
}

let defaultStore: DocumentCollectionStore | undefined;

/**
 * The process's store over the default data directory. Indexing, deletion and
 * analysis runs share it, so a deletion closes the read handles a run holds.
 */
export function getDefaultDocumentCollectionStore(): DocumentCollectionStore {
  defaultStore ??= new DocumentCollectionStore();
  return defaultStore;
}
