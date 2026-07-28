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

export interface CaseEvolutionFeedbackProjection {
  candidateId: string;
  supportingEvidence: number;
  contradictingEvidence: number;
  maintainerPromoted: boolean;
  supported: boolean;
  feedbackProjectionRejected: boolean;
}

/**
 * CaseLibrary — local file-backed case storage with a cross-process
 * read-modify-write lease for every filesystem mutation.
 */
export class CaseLibrary {
  private readonly storagePath: string;
  private readonly cases = new Map<string, CaseNode>();
  private loaded = false;
  private loadError: Error | undefined;

  constructor(storagePath: string) {
    this.storagePath = storagePath;
  }

  load(): void {
    this.loaded = true;
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
   * bypassed by a field update.
   */
  saveCase(record: CaseNode, scope?: KnowledgeScope): void {
    this.load();
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
    this.load();
    let out = enterpriseKnowledgeStoreEnabled()
      ? listScopedKnowledgeRecords<CaseNode>(
          KNOWLEDGE_KIND,
          scope,
          {
            rowScope: opts.status ? caseRowScope(opts.status) : undefined,
            rowScopePrefix: opts.status ? undefined : CASE_ROW_SCOPE_PREFIX,
          },
        ).map(row => row.record)
      : Array.from(this.cases.values());
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
      if (!existing) throw new Error(`Cannot publish case '${caseId}': not found`);
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
      if (!existing) throw new Error(`Cannot archive case '${caseId}': not found`);
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

  /**
   * Update only Case Evolution evidence projection. Published governance is
   * immutable here; non-published cases remember and restore their prior
   * status when a reversible negative projection is later retracted.
   */
  applyCaseEvolutionFeedbackProjection(
    caseId: string,
    projection: CaseEvolutionFeedbackProjection,
    scope?: KnowledgeScope,
  ): CaseNode {
    this.load();
    const project = (existing: CaseNode | undefined): CaseNode => {
      if (!existing) throw new Error(`Cannot project case '${caseId}': not found`);
      if (!existing.knowledge) {
        throw new Error(`Cannot project case '${caseId}': knowledge missing`);
      }
      const previousMarker =
        existing.knowledge.context?.['caseEvolution.v1'];
      const marker = previousMarker &&
        typeof previousMarker === 'object' &&
        !Array.isArray(previousMarker)
        ? previousMarker as Record<string, unknown>
        : {};
      const previousStatus = marker.statusBeforeFeedbackProjection;
      const statusBeforeProjection: CurationStatus | undefined =
        previousStatus === 'draft' ||
        previousStatus === 'reviewed' ||
        previousStatus === 'private'
          ? previousStatus
          : undefined;
      const {
        statusBeforeFeedbackProjection: _statusBeforeFeedbackProjection,
        supportedAt: previousSupportedAt,
        ...markerWithoutPreviousStatus
      } = marker;
      const nextStatusBeforeProjection =
        projection.feedbackProjectionRejected &&
        existing.status !== 'published'
          ? statusBeforeProjection ??
            (existing.status === 'private' ? undefined : existing.status)
          : undefined;
      const nextStatus = existing.status === 'published'
        ? 'published'
        : projection.feedbackProjectionRejected
          ? 'private'
          : statusBeforeProjection && existing.status === 'private'
            ? statusBeforeProjection
            : existing.status;
      return {
        ...existing,
        status: nextStatus,
        knowledge: {
          ...existing.knowledge,
          context: {
            ...existing.knowledge.context,
            'caseEvolution.v1': {
              ...markerWithoutPreviousStatus,
              candidateId: projection.candidateId,
              supportingEvidence: projection.supportingEvidence,
              contradictingEvidence: projection.contradictingEvidence,
              maintainerPromoted: projection.maintainerPromoted,
              supported: projection.supported,
              feedbackProjectionRejected:
                projection.feedbackProjectionRejected,
              ...(projection.supported
                ? {
                    supportedAt: typeof previousSupportedAt === 'number'
                      ? previousSupportedAt
                      : Date.now(),
                  }
                : {}),
              ...(nextStatusBeforeProjection
                ? {statusBeforeFeedbackProjection: nextStatusBeforeProjection}
                : {}),
            },
          },
        },
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
          const next = project(current);
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
      const next = project(this.cases.get(caseId));
      this.cases.set(caseId, next);
      return next;
    });
  }

  /** Stats by status — useful for the admin dashboard. */
  getStats(scope?: KnowledgeScope): Record<CurationStatus, number> {
    this.load();
    const out: Record<CurationStatus, number> = {
      draft: 0,
      reviewed: 0,
      published: 0,
      private: 0,
    };
    const cases = enterpriseKnowledgeStoreEnabled()
      ? listScopedKnowledgeRecords<CaseNode>(
          KNOWLEDGE_KIND,
          scope,
          {rowScopePrefix: CASE_ROW_SCOPE_PREFIX},
        ).map(row => row.record)
      : Array.from(this.cases.values());
    for (const c of cases) out[c.status]++;
    return out;
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
