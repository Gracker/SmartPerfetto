// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2024-2026 Gracker (Chris)
// This file is part of SmartPerfetto. See LICENSE for details.

/**
 * CaseLibrary — durable storage for `CaseNode` records (Plan 54 M0).
 *
 * The double-control publish gate from §5.2 of the unified design doc
 * lives here. A case can become `status='published'` ONLY through the
 * dedicated `publishCase()` path AND only when:
 *   1. `redactionState === 'redacted'` — the trace artifact has been
 *      anonymized and approved as such.
 *   2. A curator has signed off — `curatedBy` is set, and
 *      `publishCase()` requires the reviewer to be passed explicitly.
 *
 * `saveCase()` itself rejects records arriving with `status='published'`
 * — the only way through is the dedicated path. This makes the
 * promotion to public a deliberate API call instead of an accidental
 * field update.
 *
 * Out of scope here (M1 / M2):
 * - Case graph / edge management (`caseGraph.ts`).
 * - MCP tools (`recall_similar_case`, `cite_case_in_report`).
 * - Express CRUD route.
 *
 * @module caseLibrary
 */

import * as fs from 'fs';
import * as path from 'path';

import {
  type CaseEducationalLevel,
  type CaseNode,
  type CurationStatus,
  makeSparkProvenance,
} from '../types/sparkContracts';
import {
  enterpriseKnowledgeDbWritesEnabled,
  enterpriseKnowledgeStoreEnabled,
  legacyKnowledgeFilesystemWritesEnabled,
  type KnowledgeScope,
  getScopedKnowledgeRecord,
  listScopedKnowledgeRecords,
  mutateScopedKnowledgeRecordWithSideEffect,
  removeScopedKnowledgeRecord,
  removeScopedKnowledgeRecordIf,
  upsertScopedKnowledgeRecord,
} from './scopedKnowledgeStore';
import {withFilesystemRegistryLock} from './filesystemRegistryLock';
import {assertNotRetiredCaseWrite, isRetiredCaseNode} from './retiredCaseData';

interface StorageEnvelope {
  schemaVersion: 1;
  cases: CaseNode[];
}

const KNOWLEDGE_KIND = 'case_node';
const CASE_ROW_SCOPE_PREFIX = 'case:';

export interface ListOptions {
  status?: CurationStatus;
  /** Restrict to cases whose tag set overlaps with at least one of these. */
  anyOfTags?: string[];
  educationalLevel?: CaseEducationalLevel;
}

export interface PublishOptions {
  /** Reviewer name. Stamped onto `curatedBy` and `curatedAt`. */
  reviewer: string;
  /** Preserve an existing curation timestamp during rebuild-style writes. */
  curatedAt?: number;
}

export interface ArchiveOptions {
  reason: string;
}

/**
 * CaseLibrary — local file-backed case storage with a cross-process
 * read-modify-write lease for every filesystem mutation.
 */
export class CaseLibrary {
  private readonly storagePath: string;
  private readonly cases = new Map<string, CaseNode>();
  private loadError: Error | undefined;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
  }

  load(): void {
    this.cases.clear();
    this.loadError = undefined;
    if (!fs.existsSync(this.storagePath)) return;
    try {
      const raw = fs.readFileSync(this.storagePath, 'utf-8');
      const parsed = JSON.parse(raw) as StorageEnvelope;
      if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.cases)) {
        this.loadError = new Error('Case library schema is invalid');
        return;
      }
      for (const c of parsed.cases) this.cases.set(c.caseId, c);
    } catch (error) {
      // Corrupted JSON: file preserved, in-memory cache stays empty.
      this.loadError = new Error(
        `Case library is unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /**
   * Save (insert or replace) a case. Throws when the record arrives
   * with `status='published'` — the only legitimate path to publish
   * is the dedicated `publishCase()` call so the gate cannot be
   * bypassed by a field update — and for a retired learned case.
   */
  saveCase(record: CaseNode, scope?: KnowledgeScope): void {
    this.load();
    assertNotRetiredCaseWrite('case', isRetiredCaseNode(record), record.caseId);
    if (record.status === 'published') {
      throw new Error(
        `Use publishCase() to advance a case to 'published'; saveCase() rejects published records to keep the gate auditable`,
      );
    }
    const filesystemWrites = legacyKnowledgeFilesystemWritesEnabled();
    const databaseWrites = enterpriseKnowledgeDbWritesEnabled();
    if (filesystemWrites && databaseWrites) {
      mutateScopedKnowledgeRecordWithSideEffect<CaseNode>(
        KNOWLEDGE_KIND,
        record.caseId,
        scope,
        () => ({record, rowScope: caseRowScope(record.status)}),
        (next, current) => this.mutateFilesystem(() => {
          assertReplicaMatches('case', record.caseId, current, this.cases.get(record.caseId));
          this.cases.set(record.caseId, next);
        }),
        {createdAt: record.createdAt, updatedAt: Date.now()},
      );
      return;
    }
    if (filesystemWrites) {
      this.mutateFilesystem(() => this.cases.set(record.caseId, record));
    }
    if (databaseWrites) {
      upsertScopedKnowledgeRecord(
        KNOWLEDGE_KIND,
        record.caseId,
        caseRowScope(record.status),
        record,
        scope,
        {createdAt: record.createdAt, updatedAt: Date.now()},
      );
    }
  }

  getCase(caseId: string, scope?: KnowledgeScope): CaseNode | undefined {
    const node = this.getStoredCase(caseId, scope);
    return node && !isRetiredCaseNode(node) ? node : undefined;
  }

  /**
   * The ids of the retired cases this scope's store holds, for a store that
   * must recognize them by node facts: a retired node may carry an ordinary id.
   * A store it cannot fully read throws rather than reading as holding none.
   */
  retiredCaseIds(scope?: KnowledgeScope): Set<string> {
    const cases = this.listStoredCases(scope, undefined, {requireReadable: true});
    return new Set(cases.filter(isRetiredCaseNode).map(c => c.caseId));
  }

  removeCase(caseId: string, scope?: KnowledgeScope): boolean {
    const filesystemWrites = legacyKnowledgeFilesystemWritesEnabled();
    const databaseWrites = enterpriseKnowledgeDbWritesEnabled();
    if (filesystemWrites && databaseWrites) {
      const removed = removeScopedKnowledgeRecordIf<CaseNode>(
        KNOWLEDGE_KIND,
        caseId,
        scope,
        () => true,
        current => this.mutateFilesystem(() => {
          assertReplicaMatches('case', caseId, current, this.cases.get(caseId));
          this.cases.delete(caseId);
        }),
      );
      if (removed) return true;
      return this.mutateFilesystem(() => this.cases.delete(caseId));
    }
    let removed = false;
    if (databaseWrites) {
      removed = removeScopedKnowledgeRecord(KNOWLEDGE_KIND, caseId, scope) || removed;
    }
    if (filesystemWrites) {
      const had = this.mutateFilesystem(() => this.cases.delete(caseId));
      removed = had || removed;
    }
    return removed;
  }

  listCases(opts: ListOptions = {}, scope?: KnowledgeScope): CaseNode[] {
    let out = this.listStoredCases(scope, opts.status).filter(c => !isRetiredCaseNode(c));
    if (opts.status) out = out.filter(c => c.status === opts.status);
    if (opts.educationalLevel)
      out = out.filter(c => c.educationalLevel === opts.educationalLevel);
    if (opts.anyOfTags && opts.anyOfTags.length > 0) {
      const wanted = new Set(opts.anyOfTags);
      out = out.filter(c => c.tags.some(t => wanted.has(t)));
    }
    out.sort((a, b) => a.caseId.localeCompare(b.caseId));
    return out;
  }

  /**
   * Advance a case to `status='published'`. Enforces the double-control
   * gate:
   *   - Case must already exist (we publish a known record).
   *   - `redactionState === 'redacted'` — anonymizer must have run.
   *   - Reviewer name supplied — curator signoff is mandatory.
   *
   * Returns the published case so callers can render the new state
   * without a follow-up read. Stamps `curatedBy` / `curatedAt` from
   * the reviewer + wall clock.
   */
  publishCase(
    caseId: string,
    opts: PublishOptions,
    scope?: KnowledgeScope,
  ): CaseNode {
    this.load();
    const trimmedReviewer = opts.reviewer?.trim();
    if (!trimmedReviewer) {
      throw new Error(
        `Cannot publish case '${caseId}' without a reviewer signoff`,
      );
    }
    const publish = (existing: CaseNode | undefined): CaseNode => {
      if (!existing || isRetiredCaseNode(existing)) throw new Error(`Cannot publish case '${caseId}': not found`);
      if (existing.redactionState !== 'redacted') {
        throw new Error(
          `Cannot publish case '${caseId}': redactionState='${existing.redactionState}' (must be 'redacted')`,
        );
      }
      return {
        ...existing,
        status: 'published',
        curatedBy: trimmedReviewer,
        curatedAt: opts.curatedAt ?? Date.now(),
      };
    };
    const filesystemWrites = legacyKnowledgeFilesystemWritesEnabled();
    const databaseWrites = enterpriseKnowledgeDbWritesEnabled();
    if (databaseWrites) {
      return mutateScopedKnowledgeRecordWithSideEffect<CaseNode>(
        KNOWLEDGE_KIND,
        caseId,
        scope,
        current => {
          const next = publish(current);
          return {record: next, rowScope: caseRowScope(next.status)};
        },
        (next, current) => {
          if (!filesystemWrites) return;
          this.mutateFilesystem(() => {
            assertReplicaMatches('case', caseId, current, this.cases.get(caseId));
            this.cases.set(caseId, next);
          });
        },
      );
    }
    return this.mutateFilesystem(() => {
      const next = publish(this.cases.get(caseId));
      this.cases.set(caseId, next);
      return next;
    });
  }

  /**
   * Archive a case: drops the trace artifact pointer (so the artifact
   * store can evict the underlying file) while keeping the case
   * metadata in place for backward references. Records the supplied
   * reason on `traceUnavailableReason` so consumers see why the trace
   * is gone.
   */
  archiveCase(
    caseId: string,
    opts: ArchiveOptions,
    scope?: KnowledgeScope,
  ): CaseNode {
    this.load();
    const reason = opts.reason?.trim();
    if (!reason) {
      throw new Error(`archiveCase requires a non-empty reason`);
    }
    const archive = (existing: CaseNode | undefined): CaseNode => {
      if (!existing || isRetiredCaseNode(existing)) throw new Error(`Cannot archive case '${caseId}': not found`);
      return {
        ...existing,
        ...makeSparkProvenance({
          source: existing.source,
          notes: `archived via archiveCase`,
        }),
        traceArtifactId: undefined,
        traceUnavailableReason: reason,
      };
    };
    const filesystemWrites = legacyKnowledgeFilesystemWritesEnabled();
    const databaseWrites = enterpriseKnowledgeDbWritesEnabled();
    if (databaseWrites) {
      return mutateScopedKnowledgeRecordWithSideEffect<CaseNode>(
        KNOWLEDGE_KIND,
        caseId,
        scope,
        current => {
          const next = archive(current);
          return {record: next, rowScope: caseRowScope(next.status)};
        },
        (next, current) => {
          if (!filesystemWrites) return;
          this.mutateFilesystem(() => {
            assertReplicaMatches('case', caseId, current, this.cases.get(caseId));
            this.cases.set(caseId, next);
          });
        },
      );
    }
    return this.mutateFilesystem(() => {
      const next = archive(this.cases.get(caseId));
      this.cases.set(caseId, next);
      return next;
    });
  }

  /** Stats by status — useful for the admin dashboard. */
  getStats(scope?: KnowledgeScope): Record<CurationStatus, number> {
    const out: Record<CurationStatus, number> = {
      draft: 0,
      reviewed: 0,
      published: 0,
      private: 0,
    };
    for (const c of this.listCases({}, scope)) out[c.status]++;
    return out;
  }

  /** The stored record as is, retired or not. */
  private getStoredCase(caseId: string, scope?: KnowledgeScope): CaseNode | undefined {
    if (enterpriseKnowledgeStoreEnabled()) {
      return getScopedKnowledgeRecord<CaseNode>(
        KNOWLEDGE_KIND,
        caseId,
        scope,
      )?.record;
    }
    this.load();
    return this.cases.get(caseId);
  }

  private listStoredCases(
    scope?: KnowledgeScope,
    status?: CurationStatus,
    {requireReadable = false}: {requireReadable?: boolean} = {},
  ): CaseNode[] {
    if (enterpriseKnowledgeStoreEnabled()) {
      return listScopedKnowledgeRecords<CaseNode>(
        KNOWLEDGE_KIND,
        scope,
        {
          rowScope: status ? caseRowScope(status) : undefined,
          rowScopePrefix: status ? undefined : CASE_ROW_SCOPE_PREFIX,
          requireReadable,
        },
      ).map(row => row.record);
    }
    this.load();
    // The load error quotes the file; the caller learns only that it failed.
    if (requireReadable && this.loadError) throw new Error('case_library_unreadable');
    return Array.from(this.cases.values());
  }

  private persist(): void {
    const dir = path.dirname(this.storagePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, {recursive: true});
    // Per-process unique tmp suffix — Codex round E P1#5.
    const tmp = `${this.storagePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2)}`;
    const envelope: StorageEnvelope = {
      schemaVersion: 1,
      cases: Array.from(this.cases.values()),
    };
    fs.writeFileSync(tmp, JSON.stringify(envelope, null, 2), 'utf-8');
    fs.renameSync(tmp, this.storagePath);
  }

  private mutateFilesystem<T>(mutation: () => T): T {
    return withFilesystemRegistryLock(
      this.storagePath,
      'case_library_busy',
      () => {
        this.load();
        if (this.loadError) throw this.loadError;
        const result = mutation();
        this.persist();
        return result;
      },
    );
  }
}

function assertReplicaMatches<T>(
  kind: string,
  id: string,
  databaseRecord: T | undefined,
  filesystemRecord: T | undefined,
): void {
  if (databaseRecord === undefined || filesystemRecord === undefined) return;
  if (JSON.stringify(databaseRecord) !== JSON.stringify(filesystemRecord)) {
    throw new Error(`${kind} '${id}' has diverged database and filesystem replicas`);
  }
}

function caseRowScope(status: CurationStatus): string {
  return `${CASE_ROW_SCOPE_PREFIX}${status}`;
}
